import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthConfig, Scope } from "../config/schema.js";
import { log } from "../core/logger.js";
import { httpError } from "../core/errors.js";
import { getPrincipal, hasScope, setPrincipal, type Principal } from "./principal.js";
import type { TokenStore } from "./token-store.js";
import { clientIp, IpAllowlist, isLoopback } from "./network.js";

// 从请求里取 token：优先 Authorization: Bearer <token>，再 x-api-key。
// 两个头都是主流 SDK 会自动带的（OpenAI SDK 用 Bearer，Anthropic SDK 用 x-api-key）。
export function extractToken(req: Request): string | null {
  const authz = req.header("authorization");
  if (authz) {
    const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
    if (m) return m[1].trim();
    return authz.trim();
  }
  const apiKey = req.header("x-api-key");
  if (apiKey) return apiKey.trim();
  return null;
}

const ANONYMOUS: Principal = {
  alias: "anonymous",
  scopes: new Set<Scope>(["*"]),
  source: "anonymous",
};

export interface AuthMiddlewares {
  // 1. 网络策略 + 认证：给每个请求挂 principal，失败直接 401/403
  authenticate: RequestHandler;
  // 2. 授权：路由级声明需要的 scope
  requireScope: (scope: Scope) => RequestHandler;
  // 3. admin 路由额外的 loopback 限制
  requireLoopbackIfConfigured: RequestHandler;
}

export function makeAuth(cfg: AuthConfig, store: TokenStore): AuthMiddlewares {
  const allowlist = new IpAllowlist(cfg.ipAllowlist);

  if (!cfg.enabled) {
    log.warn("auth_disabled", {
      message: "auth.enabled=false，鉴权已关闭，任何能连上的人都有全部权限。仅本机自用（host=127.0.0.1）时才这样配。",
    });
  }

  const authenticate: RequestHandler = (req, res, next) => {
    const ip = clientIp(req);
    if (!allowlist.allows(ip)) {
      log.warn("auth_ip_rejected", { ip, path: req.path });
      return next(httpError(403, "ip_not_allowed", "source address not allowed"));
    }
    if (!cfg.enabled) {
      setPrincipal(req, ANONYMOUS);
      return next();
    }
    const token = extractToken(req);
    if (!token) {
      return next(httpError(401, "missing_token", "missing API token (Authorization: Bearer <token> or x-api-key)"));
    }
    const principal = store.verify(token);
    if (!principal) {
      log.warn("auth_rejected", { ip, path: req.path, tokenPrefix: token.slice(0, 6) });
      return next(httpError(401, "invalid_token", "invalid API token"));
    }
    setPrincipal(req, principal);
    next();
  };

  const requireScope = (scope: Scope): RequestHandler => (req, _res, next) => {
    const p = getPrincipal(req);
    if (!hasScope(p, scope)) {
      log.warn("auth_forbidden", { alias: p?.alias, scope, path: req.path });
      return next(httpError(403, "insufficient_scope", `token lacks scope "${scope}"`));
    }
    next();
  };

  const requireLoopbackIfConfigured: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    if (cfg.adminLoopbackOnly && !isLoopback(clientIp(req))) {
      return next(httpError(403, "loopback_only", "admin endpoints are only reachable from localhost"));
    }
    next();
  };

  return { authenticate, requireScope, requireLoopbackIfConfigured };
}
