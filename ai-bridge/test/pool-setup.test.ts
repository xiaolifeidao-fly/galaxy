import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceTopLevel } from "../src/modules/pool/setup/server.js";

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
