import type { Express } from "express";
import type { BridgeContext, BridgeModule } from "./types.js";

export class ModuleRegistry {
  private active: BridgeModule[] = [];

  constructor(private readonly all: BridgeModule[]) {}

  async init(ctx: BridgeContext): Promise<void> {
    this.active = this.all.filter((m) => m.enabled(ctx.cfg));
    for (const m of this.active) await m.init?.(ctx);
    ctx.log.info("modules_ready", { enabled: this.active.map((m) => m.name) });
  }

  mount(app: Express, ctx: BridgeContext): void {
    for (const m of this.active) {
      const r = m.routes?.(ctx);
      if (r) app.use(r);
    }
  }

  async start(ctx: BridgeContext): Promise<void> {
    for (const m of this.active) await m.start?.(ctx);
  }

  async stop(ctx: BridgeContext): Promise<void> {
    for (const m of [...this.active].reverse()) {
      try {
        await m.stop?.(ctx);
      } catch (e) {
        ctx.log.error("module_stop_failed", { module: m.name, message: (e as Error)?.message });
      }
    }
  }

  health(ctx: BridgeContext): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const m of this.active) {
      const h = m.health?.(ctx);
      if (h) out[m.name] = h;
    }
    return out;
  }

  names(): string[] {
    return this.active.map((m) => m.name);
  }
}
