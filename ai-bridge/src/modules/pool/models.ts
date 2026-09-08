import type { ProviderConfig } from "../../config/schema.js";
import type { CredentialRegistry } from "../../credentials/index.js";
import { log } from "../../core/logger.js";

/**
 * 上游可用模型清单。
 *
 * 控制台的「只放这些模型 / 不放这些模型」以前只能手敲，主人得自己记住上游有什么。
 * 这里把清单探出来上报给 Hub，控制台拿它当候选项。
 *
 * **这是唯一一处会真的打上游的探测**，和 probe.ts 那条「只解析凭据、不发请求」的
 * 原则是例外关系，所以要说清楚为什么可以接受：
 *   · /models 不消耗任何 token 额度，只是一次鉴权过的 GET；
 *   · 结果缓存 6 小时，hello 再频繁也不会变成对上游的压力；
 *   · 失败一律降级成空清单，绝不让它影响能力探测的结果 —— 拿不到模型名
 *     只是少了个下拉候选，不该导致这台机器报告自己不可用。
 *
 * provider 配置里写了 models 就直接用，**根本不打上游**，用于列不出来的上游。
 *
 * Codex 后端（chatgpt.com/backend-api/codex）有 /models，但有两个私有约定：
 *   · 必须带 client_version，不带直接 400（错误体明说 missing query client_version）；
 *   · 按**主版本**过滤 —— 实测 0.1.0 ~ 0.50.0 一律返回空清单，>= 1.0.0 才给完整的
 *     （0.0.0 也给，大概是当成未设置）。所以默认值取 1.0.0，可配置覆盖。
 * 它返回的条目用 slug 而不是 id，parseModels 两个都认。
 */

const TTL_MS = 6 * 60 * 60 * 1000;
/** 失败缓存短一些：上游临时抽风不该让候选项空掉半天。 */
const FAILURE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8_000;
/** Codex 后端按主版本过滤模型：0.x 给空清单，>= 1 给完整的。见上面的说明。 */
const DEFAULT_CODEX_CLIENT_VERSION = "1.0.0";

interface Entry {
  at: number;
  ttl: number;
  models: string[];
}

const cache = new Map<string, Entry>();

/** 只给测试用：清掉缓存，避免用例之间互相污染。 */
export function clearModelCache(): void {
  cache.clear();
}

export async function listModels(
  name: string,
  provider: ProviderConfig,
  credentials: CredentialRegistry,
): Promise<string[]> {
  // 配置里声明了就以它为准，一次上游都不打。
  if (provider.models?.length) return [...provider.models];
  if (!provider.baseURL) return [];

  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < hit.ttl) return [...hit.models];

  try {
    const credential = credentials.resolve(provider);
    const headers = await credential.headers({
      header: () => undefined,
      principal: { alias: "models", scopes: new Set(["*"] as const), source: "anonymous" },
      requestId: "models",
      provider,
      providerName: name,
    });
    const url = new URL(`${provider.baseURL.replace(/\/+$/, "")}/models`);
    if (provider.authMode === "codex_chatgpt") {
      url.searchParams.set("client_version", provider.modelsClientVersion ?? DEFAULT_CODEX_CLIENT_VERSION);
    }
    const response = await fetch(url, {
      headers: { ...headers, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const models = parseModels(await response.json());
    cache.set(name, { at: Date.now(), ttl: TTL_MS, models });
    log.info("pool_models_listed", { provider: name, count: models.length });
    return [...models];
  } catch (e) {
    // 降级成空清单，不往上抛：模型候选项是锦上添花，不能拖垮能力探测。
    log.warn("pool_models_unavailable", { provider: name, message: (e as Error)?.message });
    cache.set(name, { at: Date.now(), ttl: FAILURE_TTL_MS, models: [] });
    return [];
  }
}

/**
 * 兼容三种形状：OpenAI / Anthropic 的 `{data:[{id}]}`、少数网关的 `{models:["..."]}`，
 * 以及 Codex 后端的 `{models:[{slug}]}` —— 最后这个用 slug 不用 id，漏掉它的话
 * 请求明明成功了，解析出来还是空。认不出来就当空：猜错的模型名比没有更糟，
 * 主人会照着它配出一条永远匹配不上的规则，然后以为是共享池坏了。
 */
export function parseModels(payload: unknown): string[] {
  const body = payload as { data?: unknown; models?: unknown } | null;
  const rows = Array.isArray(body?.data) ? body?.data : Array.isArray(body?.models) ? body?.models : [];
  const out: string[] = [];
  for (const row of rows as unknown[]) {
    const item = row as { id?: unknown; slug?: unknown } | null;
    const id = typeof row === "string" ? row : (item?.id ?? item?.slug);
    if (typeof id === "string" && id.trim()) out.push(id.trim());
  }
  return [...new Set(out)].sort();
}
