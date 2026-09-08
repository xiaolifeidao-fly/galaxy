import http from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { parseConfig } from "../src/config/index.js";
import { createBridge, type Bridge } from "../src/app.js";
import { setLogSink } from "../src/core/logger.js";

// 测试里日志静音，只在 LOG_LEVEL=debug 时输出
if (process.env.LOG_LEVEL !== "debug") setLogSink(() => {});

export async function listen(server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}
export async function close(server: http.Server): Promise<void> {
  const finished = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await finished;
}
export async function read(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface Harness {
  url: string;
  bridge: Bridge;
  dir: string;
  authFile: string;
  calls: () => number;
  post: (path: string, body: unknown, headers?: Record<string, string>, signal?: AbortSignal) => Promise<Response>;
  get: (path: string, headers?: Record<string, string>) => Promise<Response>;
}

export const CLIENT_TOKEN = "client-test-secret-0001";
export const ADMIN_TOKEN = "admin-test-secret-0001";
export const OPENAI_ONLY_TOKEN = "openai-only-secret-0001";

type UpstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;

export async function harness(
  t: TestContext,
  upstreamHandler: UpstreamHandler,
  overrides: Record<string, unknown> = {}
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "ai-bridge-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authFile = join(dir, "credentials.json");
  await writeFile(authFile, JSON.stringify({ claudeAiOauth: {
    accessToken: "upstream-test-secret", expiresAt: Date.now() + 600_000, scopes: ["user:inference"],
  } }), { mode: 0o600 });

  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    Promise.resolve(upstreamHandler(req, res)).catch((e) => res.destroy(e));
  });
  const origin = await listen(upstream);
  t.after(() => close(upstream));

  const env = { ...process.env, AI_BRIDGE_RUNTIME_DIR: dir };
  const cfg = parseConfig({
    server: { host: "127.0.0.1", port: 0, ...(overrides.server as object ?? {}) },
    concurrency: { global: 2, queueMaxSize: 4 },
    retry: { maxAttempts: 1 },
    auth: {
      enabled: true,
      tokens: [
        { token: CLIENT_TOKEN, alias: "test", scopes: ["relay:anthropic", "relay:openai"], concurrency: 1 },
        { token: ADMIN_TOKEN, alias: "admin", scopes: ["*"] },
        { token: OPENAI_ONLY_TOKEN, alias: "openai-only", scopes: ["relay:openai"] },
      ],
      ...(overrides.auth as object ?? {}),
    },
    providers: {
      claude: { type: "relay", authMode: "claude_oauth", authFile, baseURL: origin + "/v1", concurrency: 2 },
      codex: { type: "relay", authMode: "api_key", apiKey: "codex-test-secret", baseURL: origin + "/codex" },
      ...(overrides.providers as object ?? {}),
    },
    relay: overrides.relay ?? { enabled: true, anthropic: "claude", openai: "codex" },
    agent: overrides.agent ?? { enabled: false },
    admin: overrides.admin ?? { enabled: true },
  }, env);

  const bridge = await createBridge({ cfg, env, ...(overrides.modules ? { modules: overrides.modules as never } : {}) });
  const url = await listen(bridge.server);
  t.after(() => close(bridge.server));

  return {
    url, bridge, dir, authFile, calls: () => calls,
    post: (path, body, headers = {}, signal) => fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": CLIENT_TOKEN, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal,
    }),
    get: (path, headers = {}) => fetch(url + path, { headers: { "x-api-key": CLIENT_TOKEN, ...headers } }),
  };
}

export const toolRequest = {
  model: "claude-sonnet-4-5", max_tokens: 64,
  system: [{ type: "text", text: "Client system", cache_control: { type: "ephemeral" } }],
  messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { path: "测试.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "local client result" }] },
  ],
  tools: [{ name: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
  thinking: { type: "adaptive" }, metadata: { user_id: "client-session" },
};
