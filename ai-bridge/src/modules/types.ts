import type { RequestHandler, Router } from "express";
import type { AppConfig } from "../config/schema.js";
import type { AuthMiddlewares } from "../auth/middleware.js";
import type { TokenStore } from "../auth/token-store.js";
import type { ConcurrencyGate } from "../core/queue.js";
import type { CredentialRegistry } from "../credentials/index.js";
import type { Logger } from "../core/logger.js";

// 所有模块共享的运行时上下文。模块之间不直接 import 彼此，通过 ctx.shared 交换能力。
export interface BridgeContext {
  cfg: AppConfig;
  log: Logger;
  gate: ConcurrencyGate;
  credentials: CredentialRegistry;
  auth: AuthMiddlewares;
  tokens: TokenStore;
  // TokenStore 背后的文件路径，admin / CLI 写 token 时用同一个
  tokenFile: string;
  isShuttingDown: () => boolean;
  // 模块在 init 阶段登记的跨模块能力（例如 agent 模块把自己的分发钩子放进来）
  shared: SharedCapabilities;
}

export interface SharedCapabilities {
  // agent 模块提供：请求带指定头时，把这条路径的处理交给 agent
  agentDispatch?: {
    header: string;
    handlerFor(path: string): RequestHandler | undefined;
  };
  [key: string]: unknown;
}

// 一个模块 = 一组路由 + 可选的生命周期 + 可选的健康信息。
// 新功能（不只是中转）就是新增一个目录、实现这个接口、在 modules/index.ts 登记。
export interface BridgeModule {
  readonly name: string;
  // 是否启用；关掉的模块不会被 init/mount
  enabled(cfg: AppConfig): boolean;
  // 第一阶段：所有启用模块依次 init，可往 ctx.shared 放东西
  init?(ctx: BridgeContext): Promise<void> | void;
  // 第二阶段：返回要挂载的 Router。返回值挂在根路径下；鉴权由模块自己在路由上声明
  routes?(ctx: BridgeContext): Router;
  // 服务监听成功后
  start?(ctx: BridgeContext): Promise<void> | void;
  // 优雅关闭时
  stop?(ctx: BridgeContext): Promise<void> | void;
  // /readyz 汇总用
  health?(ctx: BridgeContext): Record<string, unknown>;
}
