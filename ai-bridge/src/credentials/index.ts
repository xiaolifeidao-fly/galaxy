import type { ProviderConfig } from "../config/schema.js";
import type { CredentialProvider } from "./types.js";
import { claudeOAuthProvider } from "./claude-oauth.js";
import { codexChatGptProvider } from "./codex-chatgpt.js";
import { apiKeyProvider } from "./api-key.js";

export type { CredentialProvider, UpstreamAuthContext } from "./types.js";
export { getClaudeCreds, parseClaudeCredentials, claudeKeychainService } from "./claude-oauth.js";
export { getCodexCreds, jwtExpMs } from "./codex-chatgpt.js";

// authMode → 实现。新增上游类型时在这里登记。
export class CredentialRegistry {
  private providers = new Map<string, CredentialProvider>();

  constructor(initial: CredentialProvider[] = [claudeOAuthProvider, codexChatGptProvider, apiKeyProvider]) {
    for (const p of initial) this.register(p);
  }

  register(p: CredentialProvider) {
    this.providers.set(p.mode, p);
  }

  // relay provider 不填 authMode 时默认 codex_chatgpt（沿用 ai-sdk-client 的行为）
  resolve(provider: ProviderConfig): CredentialProvider {
    const mode = provider.authMode ?? "codex_chatgpt";
    const p = this.providers.get(mode);
    if (!p) throw new Error(`unknown authMode: ${mode}`);
    return p;
  }
}
