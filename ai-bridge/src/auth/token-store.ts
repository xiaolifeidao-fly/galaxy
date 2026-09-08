import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuthTokenSchema, type AuthConfig, type AuthToken, type Scope } from "../config/schema.js";
import { expandHome, runtimeDir } from "../core/paths.js";
import { log } from "../core/logger.js";
import type { Principal } from "./principal.js";

// token 的存储与比对。
// - 比对一律用 sha256 哈希 + timingSafeEqual：明文 token 在启动时就被哈希掉，进程内不留明文表。
// - 两个来源：config.auth.tokens（内联）与 tokenFile（CLI 维护的 JSON，只存哈希）。
//   两边 alias 冲突时 tokenFile 优先，方便运维用 CLI 覆盖配置里的旧 token。

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

interface Entry {
  hash: Buffer;
  principal: Principal;
}

interface TokenFileShape {
  version: 1;
  tokens: Array<Omit<AuthToken, "token"> & { tokenHash: string; createdAt?: string }>;
}

export function resolveTokenFile(cfg: AuthConfig, env: NodeJS.ProcessEnv = process.env): string {
  return cfg.tokenFile ? expandHome(cfg.tokenFile) : join(runtimeDir(env), "tokens.json");
}

export async function readTokenFile(path: string): Promise<TokenFileShape> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, tokens: [] };
    throw e;
  }
  const parsed = JSON.parse(raw) as TokenFileShape;
  if (parsed?.version !== 1 || !Array.isArray(parsed.tokens)) {
    throw new Error(`token 文件格式不对：${path}`);
  }
  // 复用 schema 做字段校验；文件里只允许 tokenHash
  for (const t of parsed.tokens) {
    if ("token" in t) throw new Error(`token 文件里不允许出现明文 token（alias=${(t as { alias?: string }).alias}）`);
    AuthTokenSchema.parse(t);
  }
  return parsed;
}

export async function writeTokenFile(path: string, data: TokenFileShape): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

function toPrincipal(t: AuthToken, source: Principal["source"]): Principal {
  return {
    alias: t.alias,
    scopes: new Set<Scope>(t.scopes),
    concurrency: t.concurrency,
    source,
  };
}

export class TokenStore {
  private entries: Entry[] = [];
  private byAlias = new Map<string, Entry>();

  constructor(private readonly cfg: AuthConfig, private readonly tokenFilePath: string) {}

  // 从 config + tokenFile 重建表。可以在运行时重复调用（admin reload）。
  async load(): Promise<void> {
    const next: Entry[] = [];
    const byAlias = new Map<string, Entry>();
    const add = (t: AuthToken, source: Principal["source"]) => {
      if (t.disabled) return;
      const hex = t.tokenHash ?? hashToken(t.token!);
      const entry: Entry = { hash: Buffer.from(hex, "hex"), principal: toPrincipal(t, source) };
      const existing = byAlias.get(t.alias);
      if (existing) {
        // tokenFile 覆盖 config
        const idx = next.indexOf(existing);
        if (idx >= 0) next.splice(idx, 1);
      }
      byAlias.set(t.alias, entry);
      next.push(entry);
    };
    for (const t of this.cfg.tokens) add(t, "config");
    const file = await readTokenFile(this.tokenFilePath);
    for (const t of file.tokens) add(AuthTokenSchema.parse(t), "file");
    this.entries = next;
    this.byAlias = byAlias;
    if (this.cfg.enabled && next.length === 0) {
      log.warn("auth_no_tokens", {
        message: "auth.enabled=true 但没有任何可用 token，所有业务请求都会被拒绝。用 `ai-bridge token add --alias <name>` 生成一个。",
      });
    }
  }

  size(): number {
    return this.entries.length;
  }

  // 常量时间：对每个条目都做一次比较，不因命中提前返回而泄露信息
  verify(token: string): Principal | null {
    const probe = Buffer.from(hashToken(token), "hex");
    let hit: Principal | null = null;
    for (const e of this.entries) {
      if (e.hash.length === probe.length && timingSafeEqual(e.hash, probe)) hit = e.principal;
    }
    return hit;
  }

  list(): Array<{ alias: string; scopes: Scope[]; concurrency?: number; source: Principal["source"] }> {
    return this.entries.map((e) => ({
      alias: e.principal.alias,
      scopes: [...e.principal.scopes],
      concurrency: e.principal.concurrency,
      source: e.principal.source,
    }));
  }

  hasAlias(alias: string): boolean {
    return this.byAlias.has(alias);
  }
}

// ---------- CLI / admin 用的文件操作 ----------

export async function addFileToken(path: string, opts: {
  alias: string;
  scopes: Scope[];
  concurrency?: number;
}): Promise<{ token: string }> {
  const file = await readTokenFile(path);
  if (file.tokens.some((t) => t.alias === opts.alias)) {
    throw new Error(`alias "${opts.alias}" 已存在；先 revoke 再重新生成`);
  }
  const token = generateToken();
  const entry = AuthTokenSchema.parse({
    tokenHash: hashToken(token),
    alias: opts.alias,
    scopes: opts.scopes,
    concurrency: opts.concurrency,
  });
  file.tokens.push({ ...entry, tokenHash: entry.tokenHash!, createdAt: new Date().toISOString() });
  await writeTokenFile(path, file);
  return { token };
}

export async function revokeFileToken(path: string, alias: string): Promise<boolean> {
  const file = await readTokenFile(path);
  const before = file.tokens.length;
  file.tokens = file.tokens.filter((t) => t.alias !== alias);
  if (file.tokens.length === before) return false;
  await writeTokenFile(path, file);
  return true;
}
