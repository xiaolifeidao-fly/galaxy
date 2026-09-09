import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { RelayProvider } from "../src/business/llm-chat/node/relay-provider.js";
import { CredentialRegistry } from "../src/credentials/index.js";
import { Lane } from "../src/modules/pool/lane.js";
import type { Provider, UnitEvent, WorkUnit } from "../src/business/core/index.js";

for (const status of [200, 400, 401, 429, 503]) {
  test(`pool HTTP ${status} preserves response and reports the correct terminal state`, async (t) => {
    const original = status === 429
      ? JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Error" }, request_id: "req_test" })
      : 'data: {"message":"original bytes"}\n\n';
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "content-type": status === 429 ? "application/json" : "text/event-stream", "request-id": "req_test", "retry-after": "300" });
      res.end(original);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address() as { port: number };
    const provider = new RelayProvider({
      name: "test", provider: { type: "relay", authMode: "api_key", apiKey: "test", baseURL: `http://127.0.0.1:${address.port}/v1` },
      credentials: new CredentialRegistry(),
    });
    const unit: WorkUnit = {
      id: "u_test", kind: "llm.chat", kindVersion: 1, primitive: "relay", provider: "test", consumerKey: "ck_test", state: "running",
      inputs: [{ name: "body", inline: Buffer.from('{"model":"test"}').toString("base64") }],
    };
    const events: UnitEvent[] = [];
    for await (const event of provider.run(unit, { signal: new AbortController().signal, log: () => {} })) events.push(event);
    assert.deepEqual(events[0], { type: "head", status, headers: { "content-type": status === 429 ? "application/json" : "text/event-stream", "request-id": "req_test", "retry-after": "300" } });
    const body = Buffer.concat(events.flatMap(e => e.type === "chunk" ? [e.bytes] : [])).toString();
    assert.equal(body, original);
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, status < 400 ? "done" : "error");
    if (terminal.type === "error") {
      assert.equal(terminal.code, status === 429 ? "upstream_429" : status >= 500 ? "upstream_5xx" : "upstream_rejected");
      assert.equal(terminal.retryable, status === 429 || status >= 500);
    }
  });
}

test("pool lane honors Retry-After and cannot shorten an active cooldown", () => {
  const now = Date.now();
  const lane = new Lane({ id: "test", kind: "llm.chat", kindVersion: 1, provider: "test", seats: 1, seatConcurrency: 1, models: { allow: ["*"], deny: [] } }, {} as Provider);
  lane.throttle("300", now);
  assert.equal(lane.throttledUntil?.getTime(), now + 300_000);
  assert.equal(lane.free(), 0);
  lane.throttle(undefined, now);
  assert.equal(lane.throttledUntil?.getTime(), now + 300_000);
  const later = new Date(Math.floor((now + 600_000) / 1000) * 1000);
  lane.throttle(later.toUTCString(), now);
  assert.equal(lane.throttledUntil?.getTime(), later.getTime());
  lane.throttledUntil = undefined;
  lane.throttle("invalid", now);
  assert.equal(lane.throttledUntil?.getTime(), now + 120_000);
  lane.throttledUntil = new Date(now - 1000);
  assert.equal(lane.free(), 1);
});
