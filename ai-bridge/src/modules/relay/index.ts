import { Router, type Request, type RequestHandler, type Response } from "express";
import type { AppConfig, Scope } from "../../config/schema.js";
import type { BridgeContext, BridgeModule } from "../types.js";
import { getPrincipal } from "../../auth/principal.js";
import { beginRequest } from "../../core/request.js";
import { proxyRelay, type RawBodyRequest } from "../../core/proxy.js";
import { describeError, httpError } from "../../core/errors.js";
import { resolveUpstream } from "../../credentials/index.js";
import { prepareClaudeRequest } from "../../credentials/claude-request.js";

// relay 模块：把 Anthropic Messages / OpenAI Responses / Chat Completions 转发到
// 用订阅登录态鉴权的上游。只补 Claude 订阅协议前缀，不执行客户端工具。
//
// 路径 → (协议族, scope, 错误体形态)
interface PathSpec {
  family: "anthropic" | "openai";
  scope: Scope;
  errorBody: (status: number, code: string, message: string) => unknown;
}

const anthropicError = (status: number, code: string, message: string) => ({
  type: "error", error: { type: code, message, status },
});
const openaiError = (status: number, code: string, message: string) => ({
  error: { message, type: code, code, param: null, status },
});

export const RELAY_PATHS: Record<string, PathSpec> = {
  "/v1/messages": { family: "anthropic", scope: "relay:anthropic", errorBody: anthropicError },
  "/v1/messages/count_tokens": { family: "anthropic", scope: "relay:anthropic", errorBody: anthropicError },
  "/v1/responses": { family: "openai", scope: "relay:openai", errorBody: openaiError },
  "/v1/chat/completions": { family: "openai", scope: "relay:openai", errorBody: openaiError },
};

function providerFor(cfg: AppConfig, family: PathSpec["family"]): string | undefined {
  return family === "anthropic" ? cfg.relay.anthropic : cfg.relay.openai;
}

export function makeRelayHandler(ctx: BridgeContext, path: string, spec: PathSpec): RequestHandler {
  return async function relayHandler(req: Request, res: Response) {
    const providerName = providerFor(ctx.cfg, spec.family);
    const lifecycle = beginRequest(req, res, ctx.cfg.server);
    const { requestId, signal } = lifecycle;
    const principal = getPrincipal(req)!;
    let release: (() => void) | null = null;

    const sendError = (status: number, code: string, message: string) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      res.status(status).json(spec.errorBody(status, code, message));
    };

    try {
      if (!providerName) {
        throw httpError(404, "relay_not_configured", `relay.${spec.family} 未配置，${path} 不可用`);
      }
      const pc = ctx.cfg.providers[providerName];
      if (!pc || pc.type !== "relay") {
        throw httpError(500, "relay_misconfigured", `provider "${providerName}" 不存在或不是 relay`);
      }

      const credential = ctx.credentials.resolve(pc);
      if (!credential.supportsPath(path)) {
        throw httpError(400, "unsupported_protocol", `authMode=${credential.mode} 不支持 ${path}`);
      }
      // 上游跟着本机正在用的走：接了中转站就打中转站，没接就打订阅官方。
      let upstream;
      try {
        upstream = await resolveUpstream(pc);
      } catch (e) {
        throw httpError(502, "relay_upstream_unresolved", (e as Error)?.message ?? "无法确定上游地址");
      }
      if (upstream.wireApi === "chat" && path === "/v1/responses") {
        throw httpError(400, "unsupported_protocol", `本机 Codex 中转的 wire_api 是 chat，承接不了 ${path}`);
      }
      let authHeaders: Record<string, string>;
      try {
        authHeaders = await credential.headers({
          header: (name) => req.header(name), principal, requestId, provider: pc, providerName, upstream,
        });
      } catch (e) {
        throw httpError(502, "relay_auth_failed", (e as Error)?.message ?? "relay auth failed");
      }

      release = await ctx.gate.acquire({
        providerName,
        principalAlias: principal.alias,
        principalLimit: principal.concurrency,
        waitTimeoutMs: ctx.cfg.server.queueWaitTimeoutMs,
        signal,
      });

      const startedAt = Date.now();
      ctx.log.info("relay_start", {
        requestId, alias: principal.alias, provider: providerName, authMode: credential.mode, path,
        upstream: upstream.baseURL,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        stream: req.body?.stream === true,
      });
      const { status } = await proxyRelay({
        req, res, baseURL: upstream.baseURL, authHeaders, signal, requestId,
        idleTimeoutMs: ctx.cfg.server.streamIdleTimeoutMs,
        requestBody: prepareClaudeRequest((req as RawBodyRequest).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})), pc, upstream),
      });
      ctx.log.info("relay_done", { requestId, alias: principal.alias, status, ms: Date.now() - startedAt });
    } catch (e) {
      const { status, code, message } = describeError(e);
      if (code === "client_closed") {
        ctx.log.info("relay_client_closed", { requestId, alias: principal.alias });
      } else {
        ctx.log.warn("relay_error", { requestId, alias: principal.alias, status, code, message });
      }
      sendError(status, code, message);
    } finally {
      lifecycle.dispose();
      release?.();
    }
  };
}

export const relayModule: BridgeModule = {
  name: "relay",
  enabled: (cfg) => cfg.relay.enabled,
  routes(ctx) {
    const r = Router();
    r.use(ctx.auth.authenticate);
    for (const [path, spec] of Object.entries(RELAY_PATHS)) {
      if (!providerFor(ctx.cfg, spec.family)) continue;
      const relay = makeRelayHandler(ctx, path, spec);
      const agent = ctx.shared.agentDispatch;
      const agentHandler = agent?.handlerFor(path);
      // 分发：带 agent 头且 agent 模块认领了这条路径 → agent（要求 agent scope）；否则 relay
      r.post(path, (req, res, next) => {
        if (agentHandler && agent && req.header(agent.header)) {
          return ctx.auth.requireScope("agent")(req, res, (err?: unknown) => {
            if (err) return next(err);
            Promise.resolve(agentHandler(req, res, next)).catch(next);
          });
        }
        ctx.auth.requireScope(spec.scope)(req, res, (err?: unknown) => {
          if (err) return next(err);
          Promise.resolve(relay(req, res, next)).catch(next);
        });
      });
    }
    return r;
  },
  health(ctx) {
    return { anthropic: ctx.cfg.relay.anthropic ?? null, openai: ctx.cfg.relay.openai ?? null };
  },
};
