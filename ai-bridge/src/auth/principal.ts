import type { Request } from "express";
import type { Scope } from "../config/schema.js";

// 一次请求的调用方身份。由认证中间件挂到 req 上，后续所有 handler / 日志只用它，不再碰 token。
export interface Principal {
  alias: string;
  scopes: ReadonlySet<Scope>;
  // 该 principal 的并发上限，undefined = 不限
  concurrency?: number;
  // 来源：inline 配置、token 文件，或 auth.enabled=false 时的 anonymous
  source: "config" | "file" | "anonymous";
}

const KEY = Symbol.for("ai-bridge.principal");

export function setPrincipal(req: Request, p: Principal) {
  (req as unknown as Record<symbol, Principal>)[KEY] = p;
}
export function getPrincipal(req: Request): Principal | undefined {
  return (req as unknown as Record<symbol, Principal | undefined>)[KEY];
}

export function hasScope(p: Principal | undefined, scope: Scope): boolean {
  if (!p) return false;
  return p.scopes.has("*") || p.scopes.has(scope);
}
