import type { ProviderConfig } from "../config/schema.js";
import type { UpstreamTarget } from "./local-upstream.js";

// Claude 订阅的 Messages 接口要求这段协议前缀；只有 OAuth token 不足以调用。
// 它不启用本地 agent 或工具执行。客户端 system 与工具历史仍由上游模型处理。
export const CLAUDE_OAUTH_SYSTEM = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

export function isClaudeSubscription(provider: ProviderConfig, upstream: UpstreamTarget): boolean {
  if (provider.authMode !== "claude_oauth" || upstream.auth) return false;
  try { return new URL(upstream.baseURL).origin === "https://api.anthropic.com"; }
  catch { return false; }
}

// 只补官方订阅协议要求的 system 前缀：API key / 自定义中转不改，已完整的 CLI 请求不改。
export function prepareClaudeRequest(body: Uint8Array, provider: ProviderConfig, upstream: UpstreamTarget): Uint8Array {
  if (!isClaudeSubscription(provider, upstream)) return body;
  try {
    const payload = JSON.parse(Buffer.from(body).toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return body;
    const system = payload.system;
    // 非法 system 仍交给上游校验，不悄悄吞掉输入错误。
    if (system !== undefined && typeof system !== "string" && !Array.isArray(system)) return body;
    const blocks = typeof system === "string" ? (system ? [{ type: "text", text: system }] : []) : system ?? [];
    if (blocks.some((block: { type?: string; text?: unknown } | null) => block?.type === "text" &&
        typeof block.text === "string" &&
        (block.text.startsWith(CLAUDE_OAUTH_SYSTEM) || block.text.startsWith(CLAUDE_CODE_SYSTEM)))) return body;
    payload.system = [{ type: "text", text: CLAUDE_OAUTH_SYSTEM }, ...blocks];
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}
