import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expandHome } from "../core/paths.js";
import type { CredentialProvider, UpstreamAuthContext } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ClaudeCreds {
  accessToken: string;
}

// 不把原始 JSON、子进程 stderr 或 token 放进异常/日志。
export function parseClaudeCredentials(raw: string, now = Date.now()): ClaudeCreds {
  let oauth: { accessToken?: unknown; expiresAt?: unknown; scopes?: unknown } | undefined;
  try {
    oauth = JSON.parse(raw)?.claudeAiOauth;
  } catch {
    throw new Error("Claude 登录态不是有效 JSON；请运行 claude auth login");
  }
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken.trim()) {
    throw new Error("Claude 登录态缺少 claudeAiOauth.accessToken；请运行 claude auth login");
  }
  if (oauth.expiresAt !== undefined &&
      (typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt))) {
    throw new Error("Claude 登录态 expiresAt 无效；请运行 claude auth login");
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) {
    throw new Error("Claude access token 已过期；请通过 Claude Code 更新登录态（claude auth login）");
  }
  if (Array.isArray(oauth.scopes) && !oauth.scopes.includes("user:inference")) {
    throw new Error("Claude 登录态缺少 user:inference 权限；请运行 claude auth login");
  }
  return { accessToken: oauth.accessToken.trim() };
}

export function claudeKeychainService(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR;
  const suffix = configDir
    ? `-${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}`
    : "";
  return `Claude Code-credentials${suffix}`;
}

async function readCredentialsFile(path: string): Promise<ClaudeCreds> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error("无法读取 Claude 凭据文件；检查 authFile 或先运行 claude auth login");
  }
  return parseClaudeCredentials(raw);
}

// 每次请求重新读取，Claude Code 更新登录后无需重启桥接。
// 不运行 Claude agent，不刷新/写回 OAuth 凭据，避免与 Claude Code 的 token 轮换互相覆盖。
// 读取顺序：authFile → CLAUDE_CODE_OAUTH_TOKEN → macOS Keychain → $CLAUDE_CONFIG_DIR/.credentials.json
export async function getClaudeCreds(opts: {
  authFile?: string;
  claudeKeychainService?: string;
} = {}, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeCreds> {
  if (opts.authFile) return readCredentialsFile(expandHome(opts.authFile));

  const token = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (token) return { accessToken: token };

  if (process.platform === "darwin") {
    let raw: string | undefined;
    try {
      const username = env.USER || userInfo().username;
      const account = /^[a-zA-Z0-9._-]+$/.test(username) ? username : "claude-code-user";
      const result = await execFileAsync("/usr/bin/security", [
        "find-generic-password", "-a", account, "-s",
        opts.claudeKeychainService ?? claudeKeychainService(env), "-w",
      ], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 });
      raw = result.stdout.trim();
    } catch {
      // Keychain 不可用时退回文件存储；不输出 security 的错误内容。
    }
    if (raw) return parseClaudeCredentials(raw);
  }

  const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return readCredentialsFile(join(expandHome(dir), ".credentials.json"));
}

const ANTHROPIC_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

// 透传给上游的客户端头：会话、SDK 协议头。不硬编码任何 Claude CLI 版本。
const PASSTHROUGH_HEADERS = [
  "user-agent", "x-app", "x-claude-code-session-id",
  "anthropic-dangerous-direct-browser-access",
  "x-stainless-arch", "x-stainless-lang", "x-stainless-os",
  "x-stainless-package-version", "x-stainless-retry-count",
  "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout",
];

export const claudeOAuthProvider: CredentialProvider = {
  mode: "claude_oauth",
  supportsPath: (path) => ANTHROPIC_PATHS.has(path),
  async headers({ header, provider, upstream }: UpstreamAuthContext) {
    const betas = new Set((header("anthropic-beta") || "")
      .split(",").map((s) => s.trim()).filter(Boolean));
    const headers: Record<string, string> = {
      "anthropic-version": header("anthropic-version") || "2023-06-01",
    };
    if (upstream.auth) {
      // 本机 Claude Code 接的是中转站：用它配好的令牌，不碰订阅登录态，
      // 也不加 oauth beta —— 那个头只对 OAuth token 有意义。
      if (upstream.auth.kind === "bearer") headers.authorization = `Bearer ${upstream.auth.value}`;
      else headers["x-api-key"] = upstream.auth.value;
    } else {
      const creds = await getClaudeCreds(provider);
      headers.authorization = `Bearer ${creds.accessToken}`;
      betas.add("oauth-2025-04-20");
    }
    if (betas.size) headers["anthropic-beta"] = [...betas].join(",");
    for (const name of PASSTHROUGH_HEADERS) {
      const value = header(name);
      if (value) headers[name] = value;
    }
    return headers;
  },
};
