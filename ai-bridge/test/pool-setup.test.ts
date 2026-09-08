import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConsoleURL, replaceTopLevel } from "../src/modules/pool/setup/server.js";

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

test("把端口和令牌拼进控制台地址", () => {
  const url = buildConsoleURL("https://galaxy.example.com", 39217, "abc123");
  assert.equal(url, "https://galaxy.example.com/provider/overview?bridge=39217&t=abc123");
});

test("控制台地址带路径时，落点仍是 /provider/overview", () => {
  // 部署在子路径下的控制台会给出带路径的地址，直接拼在后面会变成
  // /console/provider/overview 之外的东西，这里确认落点是绝对路径。
  const url = buildConsoleURL("https://galaxy.example.com/console/", 39217, "abc123");
  assert.equal(url, "https://galaxy.example.com/provider/overview?bridge=39217&t=abc123");
});

test("原有 query 不会被带进来，端口和令牌也不会重复", () => {
  const url = buildConsoleURL("http://127.0.0.1:7898/?foo=1", 39217, "abc123");
  assert.equal(url, "http://127.0.0.1:7898/provider/overview?bridge=39217&t=abc123");
  assert.equal((url ?? "").match(/bridge=/g)?.length, 1);
});

test("令牌里的特殊字符要转义，不能直接拼进 query", () => {
  // 当前令牌是十六进制、不会有特殊字符，但拼 URL 的地方靠「反正不会有」活着，
  // 换一种令牌编码就会静默出错。用 searchParams 拼就天然安全，这里钉住这个行为。
  const url = buildConsoleURL("https://h.example.com", 1, "a&b=c d");
  assert.ok(url?.includes("t=a%26b%3Dc+d") || url?.includes("t=a%26b%3Dc%20d"), `没转义：${url}`);
  assert.ok(!url?.includes("t=a&b=c"), "转义失败会把令牌截断成 t=a");
});

test("没有控制台地址、或地址写错时返回 undefined 而不是抛", () => {
  // 调用方据此改成打印参数让用户自己拼。为一个填错的地址让向导起不来不划算。
  assert.equal(buildConsoleURL(undefined, 39217, "abc"), undefined);
  assert.equal(buildConsoleURL("", 39217, "abc"), undefined);
  assert.equal(buildConsoleURL("   ", 39217, "abc"), undefined);
  assert.equal(buildConsoleURL("这不是个地址", 39217, "abc"), undefined);
});
