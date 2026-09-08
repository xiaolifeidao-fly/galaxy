import { test } from "node:test";
import assert from "node:assert/strict";
import { consoleOrigins, originAllowed, replaceTopLevel } from "../src/modules/pool/setup/server.js";
import type { AppConfig } from "../src/config/schema.js";

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

// ---------- 跨源白名单 ----------
//
// 控制台跨源直连本机之后，originAllowed 是唯一挡在「随便哪个网站」和
// 「能改你贡献配置的本机接口」之间的判定。令牌那道闸还在，但它只防拿不到令牌的人；
// 白名单防的是**拿到了也不该让它读**的源。这里按已知的绕过手法逐条钉住。

const empty: ReadonlySet<string> = new Set<string>();

test("白名单里的源精确放行，同源前缀的钓鱼域名不放行", () => {
  const allowed = new Set(["https://hub.example.com"]);
  assert.equal(originAllowed("https://hub.example.com", allowed), true);
  // origin 比较必须是整串相等，不能是 startsWith —— 否则下面这个就混进来了
  assert.equal(originAllowed("https://hub.example.com.evil.com", allowed), false);
  // 协议和端口都算 origin 的一部分
  assert.equal(originAllowed("http://hub.example.com", allowed), false);
  assert.equal(originAllowed("https://hub.example.com:8443", allowed), false);
});

test("回环源不限端口放行：控制台和 Hub 在不同端口上", () => {
  assert.equal(originAllowed("http://127.0.0.1:7898", empty), true);
  assert.equal(originAllowed("http://127.0.0.1:10004", empty), true);
  assert.equal(originAllowed("http://localhost:3000", empty), true);
  assert.equal(originAllowed("https://localhost", empty), true);
});

test("把回环地址塞进域名里的绕过手法一律不认", () => {
  // 经典手法：主机名里带着 127.0.0.1 / localhost，但真正解析到的是攻击者的地址。
  // 判定必须走 URL 解析取 hostname，不能对整串做 includes。
  assert.equal(originAllowed("https://127.0.0.1.evil.com", empty), false);
  assert.equal(originAllowed("https://localhost.evil.com", empty), false);
  assert.equal(originAllowed("https://evil.com/127.0.0.1", empty), false);
  assert.equal(originAllowed("https://evil.com#127.0.0.1", empty), false);
  // 内网其它机器也不是回环，不该白得一张通行证
  assert.equal(originAllowed("http://192.168.1.9:7898", empty), false);
});

test("解析不出来的 Origin 不放行，也不抛异常", () => {
  assert.equal(originAllowed("", empty), false);
  assert.equal(originAllowed("null", empty), false);
  assert.equal(originAllowed("not a url", empty), false);
});

test("白名单只收 origin，hubURL 上的路径要被丢掉", () => {
  // 存成整条 URL 是个很容易犯的错：浏览器发来的 Origin 永远不带路径，
  // 存了路径就永远匹配不上，跨域会在部署环境里静默失效。
  const cfg = { pool: { hubURL: "https://hub.example.com/galaxy/api" } } as unknown as AppConfig;
  const origins = consoleOrigins(cfg, {});
  assert.ok(origins.has("https://hub.example.com"));
  assert.ok(!origins.has("https://hub.example.com/galaxy/api"));
});

test("--console 指定的控制台源会进白名单；写错的地址被忽略而不是让向导起不来", () => {
  const cfg = { pool: { hubURL: "https://hub.example.com" } } as unknown as AppConfig;
  const origins = consoleOrigins(cfg, { consoleURL: "https://console.example.com/provider/overview" });
  assert.ok(origins.has("https://console.example.com"));
  assert.ok(origins.has("https://hub.example.com"));

  assert.doesNotThrow(() => consoleOrigins(cfg, { consoleURL: "这不是个地址" }));
  assert.equal(consoleOrigins(cfg, { consoleURL: "这不是个地址" }).size, 1);
});
