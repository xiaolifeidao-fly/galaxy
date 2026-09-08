import fs from "node:fs";
import yaml from "js-yaml";
import { AppConfigSchema, type AppConfig } from "./schema.js";
import { defaultConfigPath } from "../core/paths.js";

// 把 ${ENV_VAR} 占位符替换成 process.env 里的值；缺失时替换成空串，
// 具体字段是否必填交给 zod 判。
function expandEnv(obj: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => env[k] ?? "");
  }
  if (Array.isArray(obj)) return obj.map((v) => expandEnv(v, env));
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = expandEnv(v, env);
    return out;
  }
  return obj;
}

export interface ValidateOptions {
  // allowNoContributions 放行「mode=pool 但一条贡献都没有」。
  //
  // 只有 pool setup 该用它：那条命令的**目的**就是把第一条贡献配出来，
  // 而它得先把配置读进来才知道 hubURL 和有哪些 provider。不放行的话，
  // 装完插件第一次跑 setup 会被自己要修的那条错误挡在门外。
  allowNoContributions?: boolean;
}

// 配置文件之外的一致性校验：引用的 provider 必须存在且类型对得上。
export function validateConfig(cfg: AppConfig, options: ValidateOptions = {}): AppConfig {
  const relayTargets: Array<[string, string | undefined]> = [
    ["relay.anthropic", cfg.relay.anthropic],
    ["relay.openai", cfg.relay.openai],
  ];
  for (const [field, name] of relayTargets) {
    if (!name) continue;
    const p = cfg.providers[name];
    if (!p) throw new Error(`${field} 引用了不存在的 provider "${name}"`);
    if (p.type !== "relay" || !p.baseURL) {
      throw new Error(`${field} 引用的 provider "${name}" 必须是配置了 baseURL 的 relay`);
    }
  }
  if (cfg.relay.enabled && !cfg.relay.anthropic && !cfg.relay.openai) {
    throw new Error("relay.enabled=true 但 relay.anthropic / relay.openai 都没配");
  }
  for (const r of cfg.agent.routes) {
    const p = cfg.providers[r.provider];
    if (!p) throw new Error(`agent.routes "${r.match}" 引用了不存在的 provider "${r.provider}"`);
    if (p.type === "relay") {
      throw new Error(`agent.routes "${r.match}" 引用的 provider "${r.provider}" 是 relay，agent 路由只能指向本机 agent provider`);
    }
  }
  if (cfg.agent.enabled && cfg.agent.routes.length === 0) {
    throw new Error("agent.enabled=true 但 agent.routes 为空");
  }
  if (cfg.mode === "pool") {
    if (!cfg.pool) throw new Error("mode=pool 但缺少 pool 配置段");
    const ids = new Set<string>();
    for (const c of cfg.pool.contributions) {
      if (ids.has(c.id)) throw new Error(`pool.contributions 里 id "${c.id}" 重复`);
      ids.add(c.id);
      // 中转类能力靠 upstream 借订阅登录态；本机执行类能力靠 exec 跑命令。
      // 两者必须二选一：都不填的话，这条贡献申报上去也没人能执行它。
      if (c.upstream) {
        const p = cfg.providers[c.upstream];
        if (!p) throw new Error(`贡献 "${c.id}" 引用了不存在的 provider "${c.upstream}"`);
        if (p.type !== "relay" || !p.baseURL) {
          throw new Error(`贡献 "${c.id}" 引用的 provider "${c.upstream}" 必须是配了 baseURL 的 relay`);
        }
        if (!p.authMode) {
          throw new Error(`贡献 "${c.id}" 引用的 provider "${c.upstream}" 缺少 authMode，无法推出路由键`);
        }
      } else if (c.provider) {
        // 本机执行类能力：exec 只在需要自定义命令时填（ffmpeg 默认走 PATH），
        // 但 agent 回合那种「跑什么完全由主人决定」的能力必须显式给命令。
        if (c.kind === "delivery.task" && !c.exec) {
          throw new Error(`贡献 "${c.id}" 是 agent 回合，必须用 exec 指定执行器命令`);
        }
      } else {
        throw new Error(`贡献 "${c.id}" 既没有 upstream 也没有 provider，没有任何东西能执行它`);
      }
    }
    if (!options.allowNoContributions && cfg.pool.contributions.filter((c) => c.enabled).length === 0) {
      throw new Error("mode=pool 但没有任何启用的贡献；跑 ai-bridge pool setup 在浏览器里勾选，或用 ai-bridge pool probe 看看本机有什么能力");
    }
  }
  const aliases = new Set<string>();
  for (const t of cfg.auth.tokens) {
    if (aliases.has(t.alias)) throw new Error(`auth.tokens 里 alias "${t.alias}" 重复`);
    aliases.add(t.alias);
  }
  return cfg;
}

export function parseConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options: ValidateOptions = {},
): AppConfig {
  const parsed = AppConfigSchema.safeParse(expandEnv(raw ?? {}, env));
  if (!parsed.success) {
    throw new Error(`Invalid config: ${JSON.stringify(parsed.error.format(), null, 2)}`);
  }
  return validateConfig(parsed.data, options);
}

export function loadConfig(
  configPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ValidateOptions = {},
): AppConfig {
  const file = configPath ?? defaultConfigPath(env);
  if (!fs.existsSync(file)) {
    throw new Error(`Config file not found: ${file}（先运行 ai-bridge init）`);
  }
  const raw = yaml.load(fs.readFileSync(file, "utf8"));
  return parseConfig(raw, env, options);
}

export { AppConfigSchema } from "./schema.js";
export type { AppConfig } from "./schema.js";
