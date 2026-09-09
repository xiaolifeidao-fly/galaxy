import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  parseTomlLite, resolveClaudeUpstream, resolveCodexUpstream, resolveUpstream,
} from "../src/credentials/index.js";
import { harness, read } from "./helpers.js";

// 上游地址跟着本机正在用的走：接了中转站就打中转站，没接就打订阅官方。

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-bridge-upstream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// 不存在的托管配置路径：测试机上真有 managed-settings.json 也不该影响结果。
const NO_MANAGED = "/nonexistent/managed-settings.json";

test("TOML 轻量解析：表头、带引号的点分段、点分键、数组、布尔与注释", () => {
  const parsed = parseTomlLite(`
model_provider = "custom"   # 注释里有 = 和 [括号]
model = 'gpt-6-astra'
disable_response_storage = true
notify = ["/Applications/Some App.app/x", "turn-ended"]
retry.count = 3

[model_providers]

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://8.216.60.153:8787/v1"
headers = { "X-Foo" = "a, b", bar = 1 }

[projects."/Users/fly/Documents/develop"]
trust_level = "trusted"

[[servers]]
host = "a"
[[servers]]
host = "b"
`);
  assert.equal(parsed.model_provider, "custom");
  assert.equal(parsed.model, "gpt-6-astra");
  assert.equal(parsed.disable_response_storage, true);
  assert.deepEqual(parsed.notify, ["/Applications/Some App.app/x", "turn-ended"]);
  assert.deepEqual(parsed.retry, { count: 3 });
  const custom = (parsed.model_providers as Record<string, Record<string, unknown>>).custom;
  assert.equal(custom.base_url, "http://8.216.60.153:8787/v1");
  assert.equal(custom.requires_openai_auth, true);
  assert.deepEqual(custom.headers, { "X-Foo": "a, b", bar: 1 });
  const projects = parsed.projects as Record<string, Record<string, unknown>>;
  assert.equal(projects["/Users/fly/Documents/develop"].trust_level, "trusted");
  assert.deepEqual(parsed.servers, [{ host: "a" }, { host: "b" }]);
});

test("Codex：config.toml 指向自定义中转且 requires_openai_auth 时，地址换、登录态照旧", async (t) => {
  const home = await tempDir(t);
  await writeFile(join(home, "config.toml"), `
model_provider = "custom"
[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://relay.local:8787/v1/"
`);
  const target = await resolveCodexUpstream({}, { CODEX_HOME: home });
  assert.equal(target.baseURL, "http://relay.local:8787/v1");
  assert.equal(target.wireApi, "responses");
  assert.equal(target.auth, undefined, "仍用 ChatGPT 登录态，不带别的令牌");
  assert.match(target.source, /中转/);
});

test("Codex：experimental_bearer_token 优先于 ChatGPT 登录态；http_headers / env_http_headers 原样带上", async (t) => {
  const home = await tempDir(t);
  await writeFile(join(home, "config.toml"), `
model_provider = "custom"
[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://8.216.60.153:8787/v1"
experimental_bearer_token = "bridge-token-1"
http_headers = { "X-Team" = "galaxy" }
env_http_headers = { "X-From-Env" = "MY_HEADER", "X-Missing" = "NOT_SET" }
`);
  const target = await resolveCodexUpstream({}, { CODEX_HOME: home, MY_HEADER: "env-value" });
  assert.equal(target.baseURL, "http://8.216.60.153:8787/v1");
  assert.deepEqual(target.auth, { kind: "bearer", value: "bridge-token-1" }, "静态令牌优先，不用 ChatGPT 登录态");
  assert.deepEqual(target.headers, { "x-team": "galaxy", "x-from-env": "env-value" });
});

test("Codex：自定义中转不吃 OpenAI 登录态时按 env_key 取令牌，缺了要报清楚", async (t) => {
  const home = await tempDir(t);
  await writeFile(join(home, "config.toml"), `
model_provider = "gw"
[model_providers.gw]
base_url = "https://gw.example.com/v1"
env_key = "GW_API_KEY"
`);
  const target = await resolveCodexUpstream({}, { CODEX_HOME: home, GW_API_KEY: "gw-secret" });
  assert.deepEqual(target.auth, { kind: "bearer", value: "gw-secret" });
  assert.equal(target.wireApi, "chat", "codex 自定义 provider 的 wire_api 默认是 chat");
  await assert.rejects(resolveCodexUpstream({}, { CODEX_HOME: home }), /GW_API_KEY/);
});

test("Codex：没接中转就是订阅官方；chatgpt_base_url 可以覆盖", async (t) => {
  const home = await tempDir(t);
  const official = await resolveCodexUpstream({}, { CODEX_HOME: home });
  assert.equal(official.baseURL, "https://chatgpt.com/backend-api/codex");
  assert.equal(official.auth, undefined);
  assert.match(official.source, /官方/);

  await writeFile(join(home, "config.toml"), `chatgpt_base_url = "https://cg.example.com/backend-api/"\n`);
  const overridden = await resolveCodexUpstream({}, { CODEX_HOME: home });
  assert.equal(overridden.baseURL, "https://cg.example.com/backend-api/codex");

  // authFile 指到哪，config.toml 就在它旁边。
  const other = await tempDir(t);
  await writeFile(join(other, "config.toml"), `chatgpt_base_url = "https://other.example.com/api"\n`);
  const byAuthFile = await resolveCodexUpstream({ authFile: join(other, "auth.json") }, { CODEX_HOME: home });
  assert.equal(byAuthFile.baseURL, "https://other.example.com/api/codex");
});

test("Claude：settings.json 里的 ANTHROPIC_BASE_URL 是中转时用同处的令牌，官方时走订阅", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://relay.example.com/", ANTHROPIC_AUTH_TOKEN: "relay-token" },
  }));
  const relay = await resolveClaudeUpstream({ CLAUDE_CONFIG_DIR: dir }, { managedSettingsPath: NO_MANAGED });
  assert.equal(relay.baseURL, "https://relay.example.com/v1");
  assert.deepEqual(relay.auth, { kind: "bearer", value: "relay-token" });
  assert.match(relay.source, /settings\.json/);

  // 官方地址 + 环境里有 API key：这条路的定义就是「本机订阅」，不用 key。
  const official = await resolveClaudeUpstream(
    { CLAUDE_CONFIG_DIR: join(dir, "missing"), ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-x" },
    { managedSettingsPath: NO_MANAGED },
  );
  assert.equal(official.baseURL, "https://api.anthropic.com/v1");
  assert.equal(official.auth, undefined);

  // 什么都没配 = 官方。
  const bare = await resolveClaudeUpstream({ CLAUDE_CONFIG_DIR: join(dir, "missing") }, { managedSettingsPath: NO_MANAGED });
  assert.equal(bare.baseURL, "https://api.anthropic.com/v1");
});

test("Claude：环境变量里的中转地址生效；x-api-key、已带 /v1 的地址与 ANTHROPIC_CUSTOM_HEADERS 都认", async (t) => {
  const dir = await tempDir(t);
  const target = await resolveClaudeUpstream(
    {
      CLAUDE_CONFIG_DIR: dir, ANTHROPIC_BASE_URL: "http://127.0.0.1:9000/v1", ANTHROPIC_API_KEY: "key-1",
      ANTHROPIC_CUSTOM_HEADERS: "X-Team: galaxy\nbad line\nX-Empty:  ",
    },
    { managedSettingsPath: NO_MANAGED },
  );
  assert.equal(target.baseURL, "http://127.0.0.1:9000/v1", "不叠成 /v1/v1");
  assert.deepEqual(target.auth, { kind: "x-api-key", value: "key-1" });
  assert.deepEqual(target.headers, { "x-team": "galaxy" });
  assert.match(target.source, /环境变量/);
});

test("Claude：托管配置优先于用户配置", async (t) => {
  const dir = await tempDir(t);
  const managed = join(dir, "managed-settings.json");
  await writeFile(managed, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://managed.example.com" } }));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://user.example.com" } }));
  const target = await resolveClaudeUpstream({ CLAUDE_CONFIG_DIR: dir }, { managedSettingsPath: managed });
  assert.equal(target.baseURL, "https://managed.example.com/v1");
});

test("配置里写了 baseURL 就以它为准，不看本机 CLI；api_key 没有 baseURL 直接报错", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://relay.example.com" } }));
  const explicit = await resolveUpstream(
    { type: "relay", authMode: "claude_oauth", baseURL: "https://fixed.example.com/v1/" },
    { CLAUDE_CONFIG_DIR: dir },
  );
  assert.equal(explicit.baseURL, "https://fixed.example.com/v1");
  assert.equal(explicit.auth, undefined);
  await assert.rejects(resolveUpstream({ type: "relay", authMode: "api_key", apiKey: "k" }), /必须配置 baseURL/);
});

test("本机 relay：provider 不写 baseURL 时请求打到本机 Claude Code 配的中转，带它的令牌、不带 oauth beta", async (t) => {
  const dir = await tempDir(t);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });

  let received!: { url: string; headers: Record<string, unknown>; body: string };
  const h = await harness(t, async (req, res) => {
    received = { url: req.url!, headers: req.headers, body: await read(req) };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "message", content: [] }));
  }, {
    // provider 故意不写 baseURL、authFile 指向不存在的文件：
    // 地址与令牌都得从「本机 Claude Code 的配置」里来，订阅登录态根本不该被读。
    providers: { claude: { type: "relay", authMode: "claude_oauth", authFile: join(dir, "missing.json") } },
  });
  // 用 harness 的模拟上游冒充「本机 Claude Code 接的中转站」。它的 origin 藏在
  // codex 那条 provider（api_key，指向同一个模拟服务器）的 baseURL 里。
  const origin = (h.bridge.ctx.cfg.providers.codex?.baseURL ?? "").replace(/\/codex$/, "");
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: "relay-token" },
  }));

  const response = await h.post("/v1/messages", { model: "claude-sonnet-4-5", max_tokens: 8, messages: [] },
    { "anthropic-beta": "custom-beta" });
  assert.equal(response.status, 200);
  assert.equal(received.url, "/v1/messages");
  assert.equal(received.headers.authorization, "Bearer relay-token");
  assert.equal(received.headers["x-api-key"], undefined);
  assert.equal(received.headers["anthropic-beta"], "custom-beta", "中转令牌不加 oauth beta");
  assert.equal(h.calls(), 1);
});
