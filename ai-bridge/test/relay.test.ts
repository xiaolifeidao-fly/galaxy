import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { harness, read, toolRequest, CLIENT_TOKEN, OPENAI_ONLY_TOKEN } from "./helpers.js";
import { getClaudeCreds, parseClaudeCredentials, claudeKeychainService } from "../src/credentials/index.js";

test("credentials validate expiry, scope and malformed input without leaking tokens", () => {
  assert.deepEqual(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: {
    accessToken: "valid", expiresAt: 200, scopes: ["user:inference"],
  } }), 100), { accessToken: "valid" });
  for (const raw of ["secret-invalid-json", "{}",
    JSON.stringify({ claudeAiOauth: { accessToken: "SECRET", expiresAt: 1 } }),
    JSON.stringify({ claudeAiOauth: { accessToken: "SECRET", expiresAt: "bad" } }),
    JSON.stringify({ claudeAiOauth: { accessToken: "SECRET", scopes: ["user:profile"] } })]) {
    assert.throws(() => parseClaudeCredentials(raw),
      (e: Error) => !e.message.includes("SECRET") && !e.message.includes("secret-invalid-json"));
  }
  assert.equal(claudeKeychainService({}), "Claude Code-credentials");
  assert.match(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/custom" }), /^Claude Code-credentials-[a-f0-9]{8}$/);
  assert.equal(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/custom", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }), "Claude Code-credentials");
});

test("messages preserve raw body, tool history, OAuth headers; client secrets never reach upstream", async (t) => {
  let received!: { url: string; headers: Record<string, unknown>; body: string };
  const output = JSON.stringify({ type: "message", content: [{ type: "tool_use", id: "tool_2", name: "Read", input: { path: "local.txt" } }], stop_reason: "tool_use" });
  const h = await harness(t, async (req, res) => {
    received = { url: req.url!, headers: req.headers, body: await read(req) };
    res.setHeader("content-type", "application/json"); res.end(output);
  });
  const raw = JSON.stringify(toolRequest, null, 2) + "\n";
  const response = await h.post("/v1/messages?beta=true", raw, {
    "anthropic-version": "2023-06-01", "anthropic-beta": "custom-beta,oauth-2025-04-20",
    "x-ai-agent": "1", "user-agent": "actual-local-client", "x-app": "cli",
    "x-claude-code-session-id": "local-session", "x-stainless-lang": "js",
    "x-stainless-runtime-version": "v26.3.0", "anthropic-dangerous-direct-browser-access": "true",
    "cookie": "client-cookie-must-not-leak",
  });
  assert.equal(response.status, 200); assert.equal(await response.text(), output);
  assert.equal(received.url, "/v1/messages?beta=true"); assert.equal(received.body, raw);
  assert.equal(received.headers.authorization, "Bearer upstream-test-secret");
  assert.equal(received.headers["x-api-key"], undefined);
  assert.equal(received.headers["x-ai-agent"], undefined);
  assert.equal(received.headers["anthropic-beta"], "custom-beta,oauth-2025-04-20");
  assert.equal(received.headers["user-agent"], "actual-local-client");
  assert.equal(received.headers["x-claude-code-session-id"], "local-session");
  assert.equal(received.headers["x-stainless-lang"], "js");
  assert.equal(received.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(received.headers.cookie, undefined);
  assert.ok(response.headers.get("x-request-id"));
  assert.equal(h.calls(), 1);
});

test("SSE is byte-transparent across split UTF-8 and tool-argument chunks", async (t) => {
  const data = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"测试"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const bytes = Buffer.from(data);
  const h = await harness(t, async (req, res) => {
    assert.equal(JSON.parse(await read(req)).stream, true);
    res.setHeader("content-type", "text/event-stream");
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
    res.end();
  });
  const r = await h.post("/v1/messages", { ...toolRequest, stream: true });
  assert.match(r.headers.get("content-type")!, /text\/event-stream/);
  assert.equal(await r.text(), data);
});

test("count_tokens uses Anthropic upstream unchanged", async (t) => {
  const h = await harness(t, async (req, res) => {
    assert.equal(req.url, "/v1/messages/count_tokens");
    assert.deepEqual(JSON.parse(await read(req)), { model: "claude-sonnet-4-5", messages: [] });
    res.end('{"input_tokens":123}');
  });
  const r = await h.post("/v1/messages/count_tokens", { model: "claude-sonnet-4-5", messages: [] });
  assert.deepEqual(await r.json(), { input_tokens: 123 });
});

test("OpenAI Responses and Chat Completions go to the openai relay with api_key auth", async (t) => {
  const seen: string[] = [];
  const h = await harness(t, async (req, res) => {
    seen.push(req.url!);
    assert.equal(req.headers.authorization, "Bearer codex-test-secret");
    res.end(await read(req));
  });
  const r1 = await h.post("/v1/responses", { model: "gpt-test", input: "hello" });
  assert.deepEqual(await r1.json(), { model: "gpt-test", input: "hello" });
  const r2 = await h.post("/v1/chat/completions", { model: "gpt-test", messages: [] });
  assert.equal(r2.status, 200); await r2.text();
  assert.deepEqual(seen, ["/codex/responses", "/codex/chat/completions"]);
});

test("upstream 429, request id and rate-limit headers are preserved", async (t) => {
  const h = await harness(t, (_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "7", "request-id": "req_upstream",
      "anthropic-ratelimit-requests-remaining": "0", "x-should-retry": "true" });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}');
  });
  const r = await h.post("/v1/messages", toolRequest);
  assert.equal(r.status, 429); assert.equal(r.headers.get("retry-after"), "7");
  assert.equal(r.headers.get("request-id"), "req_upstream");
  assert.equal(r.headers.get("anthropic-ratelimit-requests-remaining"), "0");
  assert.equal(r.headers.get("x-should-retry"), "true");
  assert.equal(((await r.json()) as { error: { type: string } }).error.type, "rate_limit_error");
});

test("expired credentials fail before upstream; refreshed file is picked up without restart", async (t) => {
  const h = await harness(t, (_req, res) => res.end('{"ok":true}'));
  await writeFile(h.authFile, JSON.stringify({ claudeAiOauth: { accessToken: "expired-secret", expiresAt: 1 } }));
  const failed = await h.post("/v1/messages", toolRequest);
  assert.equal(failed.status, 502); assert.equal(h.calls(), 0);
  const body = (await failed.json()) as { type: string; error: { type: string; message: string } };
  assert.equal(body.error.type, "relay_auth_failed");
  assert.match(body.error.message, /已过期/);
  assert.ok(!body.error.message.includes("expired-secret"));
  await writeFile(h.authFile, JSON.stringify({ claudeAiOauth: { accessToken: "new-secret", expiresAt: Date.now() + 60000 } }));
  assert.equal((await getClaudeCreds({ authFile: h.authFile })).accessToken, "new-secret");
  const ok = await h.post("/v1/messages", toolRequest);
  assert.equal(ok.status, 200); await ok.text(); assert.equal(h.calls(), 1);
});

test("client auth: missing / invalid token → 401 before touching upstream; Bearer works too", async (t) => {
  const h = await harness(t, (_req, res) => res.end("{}"));
  const missing = await h.post("/v1/messages", toolRequest, { "x-api-key": "" });
  assert.equal(missing.status, 401);
  assert.equal(((await missing.json()) as { error: { type: string } }).error.type, "missing_token");
  const wrong = await h.post("/v1/messages", toolRequest, { "x-api-key": "nope-nope-nope" });
  assert.equal(wrong.status, 401); await wrong.text();
  assert.equal(h.calls(), 0);
  const bearer = await h.post("/v1/messages", toolRequest, { "x-api-key": "", authorization: `Bearer ${CLIENT_TOKEN}` });
  assert.equal(bearer.status, 200); await bearer.text();
  assert.equal(h.calls(), 1);
});

test("scope: openai-only token is refused on the anthropic path with 403", async (t) => {
  const h = await harness(t, (_req, res) => res.end("{}"));
  const denied = await h.post("/v1/messages", toolRequest, { "x-api-key": OPENAI_ONLY_TOKEN });
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as { error: { type: string } }).error.type, "insufficient_scope");
  const allowed = await h.post("/v1/responses", { input: "x" }, { "x-api-key": OPENAI_ONLY_TOKEN });
  assert.equal(allowed.status, 200); await allowed.text();
  assert.equal(h.calls(), 1);
});

test("hashed tokens in config authenticate; plaintext never stored", async (t) => {
  const { hashToken } = await import("../src/auth/token-store.js");
  const plain = "hashed-client-secret-0001";
  const h = await harness(t, (_req, res) => res.end("{}"), {
    auth: { enabled: true, tokens: [{ tokenHash: hashToken(plain), alias: "hashed", scopes: ["relay:anthropic"] }] },
  });
  const r = await h.post("/v1/messages", toolRequest, { "x-api-key": plain });
  assert.equal(r.status, 200); await r.text();
  assert.deepEqual(h.bridge.ctx.tokens.list().map((x) => x.alias), ["hashed"]);
});

test("per-principal concurrency: second concurrent request from the same token gets 429", async (t) => {
  let releaseUpstream!: () => void;
  const gate = new Promise<void>((resolve) => { releaseUpstream = resolve; });
  const h = await harness(t, async (_req, res) => { await gate; res.end("{}"); });
  const first = h.post("/v1/messages", toolRequest);
  // 等第一条真正到达上游
  await new Promise<void>((resolve) => { const i = setInterval(() => { if (h.calls() === 1) { clearInterval(i); resolve(); } }, 5); });
  const second = await h.post("/v1/messages", toolRequest);
  assert.equal(second.status, 429);
  assert.equal(((await second.json()) as { error: { type: string } }).error.type, "principal_concurrency_exceeded");
  releaseUpstream();
  assert.equal((await first).status, 200);
  await h.bridge.ctx.gate.onIdle();
});

test("ip allowlist rejects sources outside the list", async (t) => {
  const h = await harness(t, (_req, res) => res.end("{}"), { auth: { enabled: true, ipAllowlist: ["10.0.0.0/8"],
    tokens: [{ token: CLIENT_TOKEN, alias: "test", scopes: ["*"] }] } });
  const r = await h.post("/v1/messages", toolRequest);
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: { type: string } }).error.type, "ip_not_allowed");
  const health = await fetch(h.url + "/healthz");
  assert.equal(health.status, 200); await health.text();
});

test("request timeout aborts a stalled upstream and releases the concurrency slot", async (t) => {
  const h = await harness(t, () => {}, { server: { requestTimeoutMs: 100, streamIdleTimeoutMs: 5000 } });
  const r = await h.post("/v1/messages", toolRequest);
  assert.equal(r.status, 504);
  assert.equal(((await r.json()) as { error: { type: string } }).error.type, "request_timeout");
  await h.bridge.ctx.gate.onIdle();
});

test("idle timeout before headers returns 504", async (t) => {
  const h = await harness(t, () => {}, { server: { requestTimeoutMs: 5000, streamIdleTimeoutMs: 100 } });
  const r = await h.post("/v1/messages", toolRequest);
  assert.equal(r.status, 504);
  assert.equal(((await r.json()) as { error: { type: string } }).error.type, "stream_idle_timeout");
});

test("truncated upstream SSE is reported as a broken stream, not normal completion", async (t) => {
  const h = await harness(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: message_start\ndata: {}\n\n");
    setTimeout(() => res.destroy(), 50);
  });
  const r = await h.post("/v1/messages", { ...toolRequest, stream: true });
  await assert.rejects(r.text());
  await h.bridge.ctx.gate.onIdle();
});

test("client disconnect cancels the upstream and releases concurrency", async (t) => {
  let didClose!: () => void;
  const closed = new Promise<void>((resolve) => { didClose = resolve; });
  const h = await harness(t, (_req, res) => {
    res.on("close", didClose);
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: {}\n\n");
  });
  const ac = new AbortController();
  const r = await h.post("/v1/messages", { ...toolRequest, stream: true }, {}, ac.signal);
  await r.body!.getReader().read(); ac.abort();
  await Promise.race([closed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("upstream did not close")), 2000); timer.unref();
  })]);
  await h.bridge.ctx.gate.onIdle();
});

test("unconfigured relay family returns 404 and unknown routes 404", async (t) => {
  const h = await harness(t, (_req, res) => res.end("{}"), { relay: { enabled: true, anthropic: "claude" } });
  const r = await h.post("/v1/responses", { input: "x" });
  assert.equal(r.status, 404); await r.text();
  const r2 = await h.post("/v1/images/generations", {});
  assert.equal(r2.status, 404); await r2.text();
  assert.equal(h.calls(), 0);
});
