import { Router } from "express";
import type { BridgeContext, BridgeModule } from "../types.js";
import type { ModuleRegistry } from "../registry.js";

// 存活/就绪探针。不需要鉴权（也不泄露任何配置细节，只有队列计数）。
// 这个模块要拿到 registry 汇总各模块的 health，所以由 app 构造时注入。
export function healthModule(getRegistry: () => ModuleRegistry): BridgeModule {
  return {
    name: "health",
    enabled: () => true,
    routes(ctx: BridgeContext) {
      const r = Router();
      r.get("/healthz", (_req, res) => {
        res.json({ ok: true });
      });
      r.get("/readyz", (_req, res) => {
        if (ctx.isShuttingDown()) {
          res.status(503).json({ ok: false, reason: "shutting_down" });
          return;
        }
        res.json({
          ok: true,
          modules: getRegistry().names(),
          queue: ctx.gate.stats(),
          health: getRegistry().health(ctx),
        });
      });
      return r;
    },
  };
}
