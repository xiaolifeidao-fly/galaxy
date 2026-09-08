import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConsoleURL, originOf, replaceTopLevel, startSetupServer } from "../src/modules/pool/setup/server.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// replaceTopLevel 是 pool setup 唯一会**改用户文件**的地方。
// 整个 load 再 dump 会把 init 生成的那几十行注释全洗掉（7032 字节缩到 1249），
// 所以改成只切顶层块。切错一个边界就是把用户的配置写坏，这里逐条钉住。

const config = `# 顶上的说明
server:
  host: 127.0.0.1
  port: 8787

# providers 的说明
providers:
  relay_codex:
    type: relay

# 末尾的说明
log:
  level: info
`;

test("原来没有这一段时追加到末尾，其余每一行原样保留", () => {
  const out = replaceTopLevel(config, "pool", "pool:\n  hubURL: https://h\n");
  for (const line of config.split("\n")) {
    if (line !== "") assert.ok(out.includes(line), `丢了原文的一行：${line}`);
  }
  assert.ok(out.includes("pool:\n  hubURL: https://h"));
});

test("已经有这一段时是替换，不是追加", () => {
  const once = replaceTopLevel(config, "pool", "pool:\n  hubURL: https://one\n");
  const twice = replaceTopLevel(once, "pool", "pool:\n  hubURL: https://two\n");
  assert.equal(twice.split("\n").filter((l) => l.startsWith("pool:")).length, 1);
  assert.ok(twice.includes("https://two"));
  assert.ok(!twice.includes("https://one"));
});

test("替换只吃掉自己那一段，前后两段完好", () => {
  const out = replaceTopLevel(config, "providers", "providers:\n  relay_claude:\n    type: relay\n");
  assert.ok(out.includes("# 顶上的说明"));
  assert.ok(out.includes("  port: 8787"));
  assert.ok(out.includes("# 末尾的说明"));
  assert.ok(out.includes("  level: info"));
  assert.ok(!out.includes("relay_codex"), "旧的 providers 内容应当被换掉");
});

test("紧贴在块前面的注释跟着一起换掉", () => {
  // 留着它就会剩下一段描述已经不存在的字段的说明，比没有注释更误导。
  const out = replaceTopLevel(config, "providers", "providers: {}\n");
  assert.ok(!out.includes("# providers 的说明"));
  assert.ok(out.includes("# 顶上的说明"), "别的段的注释不能受牵连");
});

test("缩进的同名键不算顶层块", () => {
  const nested = "outer:\n  pool:\n    x: 1\n";
  const out = replaceTopLevel(nested, "pool", "pool:\n  hubURL: https://h\n");
  assert.ok(out.includes("  pool:\n    x: 1"), "嵌套的 pool 不该被当成顶层块动掉");
  assert.ok(out.trimEnd().endsWith("pool:\n  hubURL: https://h"), "应当追加一个新的顶层 pool");
});

test("前缀相同的键不误伤", () => {
  const text = "pool_extra: keep\nlog:\n  level: info\n";
  const out = replaceTopLevel(text, "pool", "pool: {}\n");
  assert.ok(out.includes("pool_extra: keep"));
});

test("反复替换不会越写越多空行", () => {
  let out = config;
  for (let i = 0; i < 5; i += 1) out = replaceTopLevel(out, "pool", "pool:\n  hubURL: https://h\n");
  assert.ok(!/\n{3,}/.test(out), `不该出现连续空行：\n${JSON.stringify(out)}`);
});

// ---------- 控制台入口地址 ----------
//
// 跨源全开之后，令牌是唯一的闸；而 buildConsoleURL 是令牌**唯一**的送达路径。
// 它拼错一个字符，控制台就连不上本机接口，向导起了也是白起 —— 而且失败得很安静
// （控制台只会显示「连不上本机向导」）。所以这里逐条钉住。

test("端口和令牌拼进 fragment，不能进 query", () => {
  const url = buildConsoleURL("https://galaxy.example.com", 39217, "abc123");
  assert.equal(url, "https://galaxy.example.com/provider/overview#bridge=39217&t=abc123");
  // 这条是安全断言，不是格式偏好：query 会被发给控制台服务器，令牌就此进了
  // 访问日志（Next / 反代 / CDN 各留一份），而那是主人唯一察觉不到的泄漏渠道。
  assert.ok(!new URL(url ?? "").search.includes("abc123"), "令牌不能出现在 query 里");
  assert.equal(new URL(url ?? "").search, "", "不该产生任何 query");
});

test("控制台地址带路径时，落点仍是 /provider/overview", () => {
  const url = buildConsoleURL("https://galaxy.example.com/console/", 39217, "abc123");
  assert.equal(url, "https://galaxy.example.com/provider/overview#bridge=39217&t=abc123");
});

test("原有 query 保留，端口和令牌不会重复", () => {
  const url = buildConsoleURL("http://127.0.0.1:7898/?foo=1", 39217, "abc123");
  assert.equal(url, "http://127.0.0.1:7898/provider/overview#bridge=39217&t=abc123");
  assert.equal((url ?? "").match(/bridge=/g)?.length, 1);
});

test("令牌里的特殊字符要转义，不能直接拼进 fragment", () => {
  // 当前令牌是十六进制、不会有特殊字符，但拼 URL 的地方靠「反正不会有」活着，
  // 换一种令牌编码就会静默出错。用 URLSearchParams 拼就天然安全。
  const url = buildConsoleURL("https://h.example.com", 1, "a&b=c d");
  assert.ok(url?.includes("t=a%26b%3Dc+d") || url?.includes("t=a%26b%3Dc%20d"), `没转义：${url}`);
  assert.ok(!url?.includes("t=a&b=c"), "转义失败会把令牌截断成 t=a");
});

test("没有控制台地址、或地址写错时返回 undefined 而不是抛", () => {
  assert.equal(buildConsoleURL(undefined, 39217, "abc"), undefined);
  assert.equal(buildConsoleURL("", 39217, "abc"), undefined);
  assert.equal(buildConsoleURL("   ", 39217, "abc"), undefined);
  assert.equal(buildConsoleURL("这不是个地址", 39217, "abc"), undefined);
});

// ---------- Hub 锁定 ----------
//
// /api/join 的 hubURL 以前直接取自请求体：令牌一旦泄漏，拿到的人就能把这台机器
// 重新配对到自己的 Hub，之后节点开机自动去给他干活，烧的是主人的订阅额度。
// 现在按**源**比对启动时锁定的那个，originOf 就是这条比对的全部依据。

test("按源比对：路径、尾斜杠、query 都不影响判定", () => {
  const pinned = originOf("https://hub.example.com/galaxy/api");
  assert.equal(pinned, "https://hub.example.com");
  assert.equal(originOf("https://hub.example.com"), pinned);
  assert.equal(originOf("https://hub.example.com/"), pinned);
  assert.equal(originOf("https://hub.example.com/other?x=1"), pinned);
});

test("协议、主机、端口任一不同就是另一个源", () => {
  const pinned = originOf("https://hub.example.com");
  assert.notEqual(originOf("http://hub.example.com"), pinned);
  assert.notEqual(originOf("https://hub.example.com:8443"), pinned);
  // 前缀相同的钓鱼域名必须判为不同源 —— 用 startsWith 比对就会在这里破功
  assert.notEqual(originOf("https://hub.example.com.evil.com"), pinned);
  assert.notEqual(originOf("https://evil.com/https://hub.example.com"), pinned);
});

test("解析不了的地址得到空串，且空串不等于任何已锁定的源", () => {
  assert.equal(originOf(undefined), "");
  assert.equal(originOf("这不是个地址"), "");
  // 空串参与比对时必须判不通过，否则传个垃圾地址就绕过了锁定
  assert.notEqual(originOf("垃圾"), originOf("https://hub.example.com"));
});

// ---------- 常驻 / 临时 两档鉴权 ----------
//
// 这两档的差别是整个设计的核心，写错任何一边都是安全问题：
//   · 常驻（已配对、Hub 已锁定）无令牌 —— 靠配对码。写成要令牌，就退回「只有装插件
//     那一次能配」，用户得回终端跑命令。
//   · 常驻**不能**挂 /api/state —— 那是机器指纹（机器名、能力清单、配置路径），
//     常驻接口没有令牌闸，挂上去等于对任何网站公开。
// 这两条都只在 HTTP 行为上体现，纯函数测不到，所以这里起真服务。

function poolFixture() {
  const dir = mkdtempSync(join(tmpdir(), "aib-setup-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(
    configPath,
    ["mode: pool", "providers: {}", "relay:", "  enabled: false", "pool:",
     "  hubURL: http://127.0.0.1:59999", `  tokenFile: ${join(dir, "node-token.json")}`, ""].join("\n"),
    "utf8",
  );
  return configPath;
}

test("常驻模式：ping 不要令牌，且只回布尔值", async () => {
  const handle = await startSetupServer({ configPath: poolFixture(), port: 0, resident: true });
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/ping`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.running, true);
    assert.equal(body.resident, true);
    assert.equal(body.paired, false);
    // 机器指纹一个都不能出现在这个不鉴权的端点上
    for (const leak of ["displayName", "capabilities", "configPath", "resources", "hubURL"]) {
      assert.equal(body[leak], undefined, `ping 不该吐 ${leak}`);
    }
    assert.equal(handle.token, undefined, "常驻模式不该发令牌");
  } finally {
    handle.close();
    await handle.closed;
  }
});

test("常驻模式：/api/state 不挂载（它是机器指纹，没有令牌闸就不能开）", async () => {
  const handle = await startSetupServer({ configPath: poolFixture(), port: 0, resident: true });
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/state`);
    assert.equal(response.status, 404);
  } finally {
    handle.close();
    await handle.closed;
  }
});

test("常驻模式：/api/join 不因缺令牌而 401 —— 配对码才是凭据", async () => {
  const handle = await startSetupServer({ configPath: poolFixture(), port: 0, resident: true });
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "XXXX-YYYY" }),
    });
    // Hub 是个不存在的地址，所以会失败 —— 但**不能**是 401。
    // 401 说明令牌闸被误开在了常驻档上，用户就又得回终端了。
    assert.notEqual(response.status, 401, "常驻模式不该要求令牌");
    assert.equal(response.status, 400);
  } finally {
    handle.close();
    await handle.closed;
  }
});

test("临时模式：发令牌，且 /api/join 缺令牌就是 401", async () => {
  const handle = await startSetupServer({ configPath: poolFixture(), port: 0, resident: false });
  try {
    assert.ok(handle.token && handle.token.length === 64, "临时模式必须发 32 字节令牌");
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "XXXX-YYYY" }),
    });
    // 新机器没有锁定的 Hub，这一档必须靠令牌闸挡住恶意站点把机器配对到别处
    assert.equal(response.status, 401);
  } finally {
    handle.close();
    await handle.closed;
  }
});
