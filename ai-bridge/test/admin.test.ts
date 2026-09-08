import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { harness, ADMIN_TOKEN, toolRequest } from "./helpers.js";

test("admin: status/tokens require admin scope; token lifecycle works end-to-end", async (t) => {
  const h = await harness(t, (_req, res) => res.end("{}"));

  const denied = await h.get("/admin/status");
  assert.equal(denied.status, 403); await denied.text();

  const status = await h.get("/admin/status", { "x-api-key": ADMIN_TOKEN });
  assert.equal(status.status, 200);
  const s = (await status.json()) as { auth: { tokens: number }; relay: { anthropic: string } };
  assert.equal(s.relay.anthropic, "claude");
  assert.equal(s.auth.tokens, 3);

  // 生成一个新 token → 只存哈希 → 立即可用
  const created = await h.post("/admin/tokens", { alias: "newbie", scopes: ["relay:anthropic"] }, { "x-api-key": ADMIN_TOKEN });
  assert.equal(created.status, 201);
  const { token } = (await created.json()) as { token: string };
  const file = JSON.parse(await readFile(join(h.dir, "tokens.json"), "utf8")) as { tokens: Array<Record<string, unknown>> };
  assert.equal(file.tokens.length, 1);
  assert.equal(file.tokens[0].alias, "newbie");
  assert.ok(!("token" in file.tokens[0]));
  assert.ok(!JSON.stringify(file).includes(token));

  const use = await h.post("/v1/messages", toolRequest, { "x-api-key": token });
  assert.equal(use.status, 200); await use.text();

  const dup = await h.post("/admin/tokens", { alias: "newbie" }, { "x-api-key": ADMIN_TOKEN });
  assert.equal(dup.status, 409); await dup.text();

  const revoked = await fetch(h.url + "/admin/tokens/newbie", { method: "DELETE", headers: { "x-api-key": ADMIN_TOKEN } });
  assert.equal(revoked.status, 200); await revoked.text();
  const after = await h.post("/v1/messages", toolRequest, { "x-api-key": token });
  assert.equal(after.status, 401); await after.text();
});

test("readyz exposes modules and queue; healthz needs no auth", async (t) => {
  const h = await harness(t, (_req, res) => res.end("{}"));
  const r = await fetch(h.url + "/readyz");
  const body = (await r.json()) as { ok: boolean; modules: string[]; queue: { providers: Record<string, unknown> } };
  assert.equal(body.ok, true);
  assert.deepEqual(body.modules, ["health", "relay", "admin"]);
  assert.ok(body.queue.providers.claude);
});
