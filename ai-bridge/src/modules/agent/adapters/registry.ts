import type { AppConfig } from "../../../config/schema.js";
import type { ModelAdapter } from "./types.js";
import { CodexLocalAdapter } from "./codex-local.js";
import { ClaudeCodeLocalAdapter } from "./claude-code-local.js";
import { httpError } from "../../../core/errors.js";

export interface RouteResolution {
  adapter: ModelAdapter;
  providerName: string;
  upstreamModel: string;
}

function matchGlob(pattern: string, input: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === input;
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
  );
  return re.test(input);
}

// model 名 → 本机 agent adapter。只为 agent.routes 引用到的 provider 建 adapter。
export class AdapterRegistry {
  private adapters = new Map<string, ModelAdapter>();
  constructor(private cfg: AppConfig) {
    const used = new Set(cfg.agent.routes.map((r) => r.provider));
    for (const [name, pc] of Object.entries(cfg.providers)) {
      if (!used.has(name)) continue;
      if (pc.type === "codex_local") this.adapters.set(name, new CodexLocalAdapter(name, pc));
      else if (pc.type === "claude_code_local") this.adapters.set(name, new ClaudeCodeLocalAdapter(name, pc));
    }
  }

  resolve(model: string): RouteResolution {
    for (const r of this.cfg.agent.routes) {
      if (matchGlob(r.match, model)) {
        const adapter = this.adapters.get(r.provider);
        if (!adapter) throw httpError(500, "provider_not_found", `Provider not found: ${r.provider}`);
        return { adapter, providerName: r.provider, upstreamModel: r.rewriteTo ?? model };
      }
    }
    throw httpError(404, "model_not_found", `No route matched for model: ${model}`);
  }
}
