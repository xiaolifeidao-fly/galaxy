import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expandHome, runtimeDir } from "../../core/paths.js";
import type { PoolConfig } from "../../config/schema.js";

// 节点令牌的落盘。
//
// 与 auth/tokens.json 只存哈希不同，这把令牌必须能在重启后原样出示给 Hub，
// 所以它是明文存的 —— 存哈希就等于每次重启都要重新配对，与「长期 node token」矛盾。
// 防护手段是文件权限 0600 + 目录 0700，与 ~/.codex/auth.json、~/.claude/.credentials.json
// 这些本机凭据一致；日志里只出现指纹，永远不出现明文。

export interface NodeIdentityFile {
  version: 1;
  nodeId: string;
  token: string;
  hubURL: string;
  pairedAt: string;
}

export function resolveNodeTokenFile(pool: PoolConfig | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return pool?.tokenFile ? expandHome(pool.tokenFile) : join(runtimeDir(env), "node-token.json");
}

export async function readNodeIdentity(path: string): Promise<NodeIdentityFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as NodeIdentityFile;
    if (parsed?.version !== 1 || !parsed.token || !parsed.nodeId) {
      throw new Error(`节点令牌文件格式不对：${path}`);
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw e;
  }
}

export async function writeNodeIdentity(path: string, value: NodeIdentityFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

// fingerprint 是日志里代表这把令牌的东西：足以在排障时区分两台机器，
// 又不足以拿去冒充。
export function fingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}
