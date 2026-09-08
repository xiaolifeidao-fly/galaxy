import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config/index.js";

const base = {
  providers: {
    claude: { type: "relay", authMode: "claude_oauth", baseURL: "https://api.anthropic.com/v1" },
    local: { type: "claude_code_local" },
  },
  relay: { anthropic: "claude" },
};

test("defaults: loopback host, auth enabled, agent disabled", () => {
  const cfg = parseConfig(base);
  assert.equal(cfg.server.host, "127.0.0.1");
  assert.equal(cfg.auth.enabled, true);
  assert.equal(cfg.agent.enabled, false);
  assert.equal(cfg.admin.enabled, true);
});

test("relay must reference a relay provider with baseURL", () => {
  assert.throws(() => parseConfig({ ...base, relay: { anthropic: "local" } }), /必须是配置了 baseURL 的 relay/);
  assert.throws(() => parseConfig({ ...base, relay: { anthropic: "missing" } }), /不存在的 provider/);
  assert.throws(() => parseConfig({ ...base, relay: { enabled: true } }), /都没配/);
});

test("agent routes must point at local agent providers", () => {
  assert.throws(() => parseConfig({ ...base, agent: { enabled: true, routes: [{ match: "*", provider: "claude" }] } }), /只能指向本机 agent/);
  assert.throws(() => parseConfig({ ...base, agent: { enabled: true, routes: [] } }), /routes 为空/);
  const ok = parseConfig({ ...base, agent: { enabled: true, routes: [{ match: "*", provider: "local" }] } });
  assert.equal(ok.agent.header, "x-ai-agent");
});

test("token entries need exactly one of token / tokenHash and unique aliases", () => {
  assert.throws(() => parseConfig({ ...base, auth: { tokens: [{ alias: "a" }] } }), /Invalid config/);
  assert.throws(() => parseConfig({ ...base, auth: { tokens: [
    { alias: "a", token: "12345678" }, { alias: "a", token: "87654321" },
  ] } }), /重复/);
  const cfg = parseConfig({ ...base, auth: { tokens: [{ alias: "a", token: "${T}" }] } }, { T: "env-token-1" });
  assert.equal(cfg.auth.tokens[0].token, "env-token-1");
  assert.deepEqual(cfg.auth.tokens[0].scopes, ["relay:anthropic", "relay:openai"]);
});
