import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_OAUTH_SYSTEM, prepareClaudeRequest } from "../src/credentials/claude-request.js";
import { RelayProvider } from "../src/business/llm-chat/node/relay-provider.js";
import { CredentialRegistry } from "../src/credentials/index.js";
import type { ProviderConfig } from "../src/config/schema.js";
import type { WorkUnit } from "../src/business/core/index.js";

const provider: ProviderConfig = { type: "relay", authMode: "claude_oauth" };
const upstream = { baseURL: "https://api.anthropic.com/v1", source: "test" };
const request = {
  model: "claude-sonnet-5", max_tokens: 256, stream: true,
  messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: { q: "test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
  ],
  tools: [{ name: "lookup", input_schema: { type: "object" } }],
};

test("Claude subscription prepends protocol context while preserving custom system, history and tools", () => {
  for (const system of [undefined, "", "Answer in Chinese", [{ type: "text", text: "custom", cache_control: { type: "ephemeral" } }]]) {
    const raw = Buffer.from(JSON.stringify({ ...request, system }));
    const prepared = prepareClaudeRequest(raw, provider, upstream);
    const parsed = JSON.parse(Buffer.from(prepared).toString());
    assert.equal(parsed.system[0].text, CLAUDE_OAUTH_SYSTEM);
    assert.deepEqual(parsed.messages, request.messages);
    assert.deepEqual(parsed.tools, request.tools);
    assert.equal(parsed.max_tokens, 256);
    assert.equal(parsed.stream, true);
    if (system) assert.deepEqual(parsed.system.slice(1), typeof system === "string" ? [{ type: "text", text: system }] : system);
    assert.equal(prepareClaudeRequest(prepared, provider, upstream), prepared);
  }
});

test("complete SDK/CLI bodies and non-subscription traffic stay byte-identical", () => {
  for (const text of [CLAUDE_OAUTH_SYSTEM, "You are Claude Code, Anthropic's official CLI for Claude."]) {
    const raw = Buffer.from(JSON.stringify({ ...request, system: [{ type: "text", text }] }, null, 2) + "\n");
    assert.equal(prepareClaudeRequest(raw, provider, upstream), raw);
  }
  const raw = Buffer.from(JSON.stringify(request));
  assert.equal(prepareClaudeRequest(raw, { ...provider, authMode: "api_key" }, upstream), raw);
  assert.equal(prepareClaudeRequest(raw, provider, { ...upstream, baseURL: "https://custom.example/v1" }), raw);
  assert.equal(prepareClaudeRequest(raw, provider, { ...upstream, auth: { kind: "bearer", value: "test" } }), raw);
  for (const invalid of ['{', 'null', '[]', '{"system":123}', '{"system":null}']) {
    const bytes = Buffer.from(invalid);
    assert.equal(prepareClaudeRequest(bytes, provider, upstream), bytes);
  }
});

test("pool sends subscription-compatible body and forwards SSE without running local tools", async (t) => {
  const response = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, upstream.baseURL + "/messages");
    const parsed = JSON.parse(Buffer.from(init.body as Uint8Array).toString());
    assert.equal(parsed.system[0].text, CLAUDE_OAUTH_SYSTEM);
    assert.deepEqual(parsed.messages, request.messages);
    assert.deepEqual(parsed.tools, request.tools);
    return new Response(response, { headers: { "content-type": "text/event-stream" } });
  });
  const relay = new RelayProvider({ name: "claude_oauth", provider: { ...provider, baseURL: upstream.baseURL }, credentials: new CredentialRegistry([
    { mode: "claude_oauth", supportsPath: () => true, headers: async () => ({ authorization: "Bearer test" }) },
  ]) });
  const unit: WorkUnit = { id: "test", kind: "llm.chat", kindVersion: 1, primitive: "relay", provider: "claude_oauth", consumerKey: "ck", state: "running", inputs: [{ name: "body", inline: Buffer.from(JSON.stringify(request)).toString("base64") }] };
  const chunks: Uint8Array[] = [];
  for await (const event of relay.run(unit, { signal: new AbortController().signal, log: () => {} })) {
    if (event.type === "head") assert.equal(event.status, 200);
    if (event.type === "chunk") chunks.push(event.bytes);
    assert.notEqual(event.type, "error");
  }
  assert.equal(calls, 1);
  assert.equal(Buffer.concat(chunks).toString(), response);
});
