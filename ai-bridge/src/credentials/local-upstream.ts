import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { expandHome } from "../core/paths.js";
import type { ProviderConfig } from "../config/schema.js";

// 上游地址跟着**本机正在用的**那一个走。
//
// 桥接是借这台机器的 Claude Code / Codex 订阅登录态干活的。这台机器自己如果接的是
// 别家中转站（Codex 的 config.toml 里 model_provider 指向自定义 base_url，或 Claude Code
// 的 settings.json / 环境变量里配了 ANTHROPIC_BASE_URL），那份登录态很可能只在那个
// 中转站上有效，硬打官方地址反而 401。反过来没配中转就是订阅官方，直连即可。
//
// 所以 provider 不写 baseURL 时，这里按各家 CLI 自己的读法把地址解析出来；
// 写了 baseURL 就是主人的明确决定，一律以它为准。每次请求重新读，改完配置不用重启。

export const OFFICIAL_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
// Codex 的 chatgpt_base_url 默认值；订阅登录态打的是它下面的 /codex。
export const OFFICIAL_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/";

export interface UpstreamAuth {
  kind: "bearer" | "x-api-key";
  value: string;
}

export interface UpstreamTarget {
  // 已含协议前缀路径：anthropic 以 /v1 结尾，codex 以 /codex 或中转自己的 /v1 结尾。
  // 请求路径去掉客户端的 /v1 后直接接上去。
  baseURL: string;
  // 人话，给日志与控制台看：从哪读来的。
  source: string;
  // 本机接中转站用的令牌。空表示用订阅登录态（凭据提供者自己去读）。
  auth?: UpstreamAuth;
  // 本机 CLI 配置里要求每个请求都带的静态头（Codex 的 http_headers / env_http_headers，
  // Claude Code 的 ANTHROPIC_CUSTOM_HEADERS）。中转站的鉴权常常就藏在这里。
  headers?: Record<string, string>;
  // Codex 自定义 provider 的协议：chat 只能走 /v1/chat/completions。
  wireApi?: "responses" | "chat";
}

// 按 provider 解析上游。配置里写了 baseURL 就用它，不看本机 CLI 的配置。
export async function resolveUpstream(
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpstreamTarget> {
  if (provider.baseURL) {
    return { baseURL: trimSlash(provider.baseURL), source: "配置 baseURL" };
  }
  switch (provider.authMode) {
    case "claude_oauth":
      return resolveClaudeUpstream(env);
    case "codex_chatgpt":
      return resolveCodexUpstream(provider, env);
    default:
      throw new Error(`authMode=${provider.authMode ?? "api_key"} 的 provider 必须配置 baseURL`);
  }
}

// ---------- Claude Code ----------

const CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS",
] as const;

interface EnvLayer {
  name: string;
  env: Partial<Record<(typeof CLAUDE_ENV_KEYS)[number], string>>;
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? expandHome(env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}

// 企业托管配置。它的优先级最高：主人自己改不动，桥接也不该绕过去。
export function managedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "win32":
      return "C:\\ProgramData\\ClaudeCode\\managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}

async function readSettingsEnv(path: string): Promise<EnvLayer["env"] | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const env = (JSON.parse(raw) as { env?: Record<string, unknown> })?.env;
    if (!env || typeof env !== "object") return undefined;
    return pickClaudeEnv(env);
  } catch {
    // settings.json 写坏了是 Claude Code 自己的问题；这里当没有，退到下一层。
    return undefined;
  }
}

function pickClaudeEnv(source: Record<string, unknown>): EnvLayer["env"] {
  const out: EnvLayer["env"] = {};
  for (const key of CLAUDE_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

/**
 * Claude Code 的上游读法：managed-settings.json > ~/.claude/settings.json 的 env > 进程环境变量。
 *
 * 官方地址 → 订阅登录态直连，忽略环境里的 API key（那是「本机订阅」这条路的定义）。
 * 中转地址 → 用同一套配置里的 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY；一个都没有
 * 就仍然带订阅登录态过去（有些中转本来就是拿 OAuth token 透传的）。
 */
export async function resolveClaudeUpstream(
  env: NodeJS.ProcessEnv = process.env,
  options: { managedSettingsPath?: string } = {},
): Promise<UpstreamTarget> {
  const layers: EnvLayer[] = [];
  const managed = await readSettingsEnv(options.managedSettingsPath ?? managedSettingsPath());
  if (managed) layers.push({ name: "managed-settings.json", env: managed });
  const user = await readSettingsEnv(join(claudeConfigDir(env), "settings.json"));
  if (user) layers.push({ name: "settings.json", env: user });
  layers.push({ name: "环境变量", env: pickClaudeEnv(env as Record<string, unknown>) });

  const baseLayer = layers.find((layer) => layer.env.ANTHROPIC_BASE_URL);
  const rawBase = baseLayer?.env.ANTHROPIC_BASE_URL ?? OFFICIAL_ANTHROPIC_BASE_URL;
  const baseURL = withV1(rawBase);
  if (isOfficialAnthropic(rawBase)) {
    return { baseURL, source: "Anthropic 官方（本机订阅）" };
  }

  const auth = findClaudeAuth(layers);
  const custom = layers.find((layer) => layer.env.ANTHROPIC_CUSTOM_HEADERS)?.env.ANTHROPIC_CUSTOM_HEADERS;
  const headers = custom ? parseCustomHeaders(custom) : {};
  return {
    baseURL,
    source: `本机 Claude Code 中转（${baseLayer!.name} ANTHROPIC_BASE_URL）`,
    ...(auth ? { auth } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

// ANTHROPIC_CUSTOM_HEADERS 的格式是每行一个 "Name: Value"。
function parseCustomHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name && value) headers[name] = value;
  }
  return headers;
}

function findClaudeAuth(layers: EnvLayer[]): UpstreamAuth | undefined {
  for (const layer of layers) {
    if (layer.env.ANTHROPIC_AUTH_TOKEN) return { kind: "bearer", value: layer.env.ANTHROPIC_AUTH_TOKEN };
    if (layer.env.ANTHROPIC_API_KEY) return { kind: "x-api-key", value: layer.env.ANTHROPIC_API_KEY };
  }
  return undefined;
}

function isOfficialAnthropic(url: string): boolean {
  try {
    return new URL(url).host === "api.anthropic.com";
  } catch {
    return false;
  }
}

// Claude Code 是把 /v1/messages 直接接在 ANTHROPIC_BASE_URL 后面的；
// 这里也这么接，只是有人手滑写了 /v1 结尾时不叠成 /v1/v1。
function withV1(url: string): string {
  const base = trimSlash(url);
  return base.endsWith("/v1") ? base : base + "/v1";
}

// ---------- Codex ----------

export function codexHome(authFile: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (authFile) return dirname(expandHome(authFile));
  if (env.CODEX_HOME) return expandHome(env.CODEX_HOME);
  return join(homedir(), ".codex");
}

/**
 * Codex 的上游读法（config.toml）：
 *
 *   model_provider = "xxx" 且 [model_providers.xxx] 有 base_url → 本机接的是中转。
 *     鉴权按 Codex 自己的优先级：
 *       experimental_bearer_token → 静态 Bearer（常见于接另一台 ai-bridge）；
 *       requires_openai_auth = true → ChatGPT 登录态，头和直连官方一样；
 *       env_key → 从环境变量取 Bearer；都没有就不带鉴权。
 *     http_headers / env_http_headers 是每个请求都带的静态头，原样跟着走。
 *     wire_api 默认 chat；只有 responses 才能承接 /v1/responses。
 *   没有自定义 provider → 订阅官方：chatgpt_base_url（默认 chatgpt.com/backend-api/）+ codex。
 */
export async function resolveCodexUpstream(
  provider: Pick<ProviderConfig, "authFile">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpstreamTarget> {
  const home = codexHome(provider.authFile, env);
  let config: Record<string, unknown> = {};
  try {
    config = parseTomlLite(await readFile(join(home, "config.toml"), "utf8"));
  } catch {
    // 没有 config.toml 就是全默认：订阅官方。
  }

  const providerId = stringOf(config.model_provider) ?? "openai";
  const providers = asTable(config.model_providers);
  const custom = asTable(providers[providerId]);
  const customBase = stringOf(custom.base_url);
  if (providerId !== "openai" && customBase) {
    const wireApi = custom.wire_api === "responses" ? "responses" : "chat";
    let auth: UpstreamAuth | undefined;
    const bearer = stringOf(custom.experimental_bearer_token);
    if (bearer) {
      auth = { kind: "bearer", value: bearer };
    } else if (custom.requires_openai_auth !== true) {
      const envKey = stringOf(custom.env_key);
      if (envKey) {
        const value = env[envKey]?.trim();
        if (!value) {
          throw new Error(`本机 Codex 中转 ${providerId} 需要环境变量 ${envKey}，当前为空`);
        }
        auth = { kind: "bearer", value };
      }
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(asTable(custom.http_headers))) {
      if (typeof value === "string" && value.trim()) headers[name.toLowerCase()] = value.trim();
    }
    for (const [name, envName] of Object.entries(asTable(custom.env_http_headers))) {
      const value = typeof envName === "string" ? env[envName]?.trim() : undefined;
      if (value) headers[name.toLowerCase()] = value;
    }
    return {
      baseURL: trimSlash(customBase),
      source: `本机 Codex 中转（config.toml model_provider=${providerId}）`,
      wireApi,
      ...(auth ? { auth } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }

  const chatgptBase = stringOf(config.chatgpt_base_url);
  return {
    baseURL: trimSlash(chatgptBase ?? OFFICIAL_CHATGPT_BASE_URL) + "/codex",
    source: chatgptBase ? "本机 Codex 中转（config.toml chatgpt_base_url）" : "ChatGPT 官方（本机订阅）",
    wireApi: "responses",
  };
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asTable(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

// ---------- 轻量 TOML ----------
//
// 只为读 config.toml 里几个标量键，不引第三方依赖。支持表头（含带引号的点分段）、
// 数组表头、点分键、基本/字面字符串、布尔、数字、单行数组与内联表。
// 认不出的值原样存成字符串 —— 读不懂的键这里本来就不用。

export function parseTomlLite(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    if (line.startsWith("[")) {
      const isArray = line.startsWith("[[");
      const close = line.lastIndexOf(isArray ? "]]" : "]");
      if (close < 0) continue;
      const keys = splitKeyPath(line.slice(isArray ? 2 : 1, close).trim());
      if (keys.length === 0) continue;
      let node = root;
      keys.forEach((key, index) => {
        const last = index === keys.length - 1;
        if (last && isArray) {
          const list = Array.isArray(node[key]) ? (node[key] as Record<string, unknown>[]) : [];
          node[key] = list;
          const table: Record<string, unknown> = {};
          list.push(table);
          node = table;
          return;
        }
        node = descend(node, key);
      });
      current = node;
      continue;
    }

    const eq = indexOfUnquoted(line, "=");
    if (eq < 0) continue;
    const keys = splitKeyPath(line.slice(0, eq).trim());
    if (keys.length === 0) continue;
    let node = current;
    for (const key of keys.slice(0, -1)) node = descend(node, key);
    node[keys[keys.length - 1]] = parseValue(line.slice(eq + 1).trim());
  }
  return root;
}

function descend(node: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = node[key];
  if (Array.isArray(existing)) {
    const last = existing[existing.length - 1];
    if (last && typeof last === "object") return last as Record<string, unknown>;
  }
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const table: Record<string, unknown> = {};
  node[key] = table;
  return table;
}

function stripComment(line: string): string {
  const index = indexOfUnquoted(line, "#");
  return index < 0 ? line : line.slice(0, index);
}

// 找引号外第一个 needle。TOML 的注释与等号都不能出现在字符串里被误认。
function indexOfUnquoted(text: string, needle: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (text.startsWith(needle, i)) return i;
  }
  return -1;
}

function splitKeyPath(raw: string): string[] {
  const keys: string[] = [];
  let buffer = "";
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < raw.length) buffer += raw[++i];
      else if (ch === quote) quote = null;
      else buffer += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      keys.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  keys.push(buffer.trim());
  return keys.filter(Boolean);
}

function parseValue(raw: string): unknown {
  if (raw.startsWith('"""') || raw.startsWith("'''")) return raw;
  if (raw.startsWith('"')) return unescapeBasic(raw.slice(1, raw.endsWith('"') && raw.length > 1 ? -1 : undefined));
  if (raw.startsWith("'")) return raw.slice(1, raw.endsWith("'") && raw.length > 1 ? -1 : undefined);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ""));
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return splitTopLevel(raw.slice(1, -1)).map(parseValue);
  }
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const table: Record<string, unknown> = {};
    for (const pair of splitTopLevel(raw.slice(1, -1))) {
      const eq = indexOfUnquoted(pair, "=");
      if (eq < 0) continue;
      const keys = splitKeyPath(pair.slice(0, eq).trim());
      if (keys.length === 0) continue;
      let node = table;
      for (const key of keys.slice(0, -1)) node = descend(node, key);
      node[keys[keys.length - 1]] = parseValue(pair.slice(eq + 1).trim());
    }
    return table;
  }
  return raw;
}

// 按引号与括号之外的逗号切分。
function splitTopLevel(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buffer = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      buffer += ch;
      if (ch === "\\" && quote === '"' && i + 1 < raw.length) buffer += raw[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  if (buffer.trim()) parts.push(buffer.trim());
  return parts;
}

function unescapeBasic(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, code: string) => {
    switch (code[0]) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case '"': return '"';
      case "\\": return "\\";
      case "u":
      case "U": return String.fromCodePoint(parseInt(code.slice(1), 16));
      default: return code;
    }
  });
}
