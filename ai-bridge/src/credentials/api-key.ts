import type { CredentialProvider, UpstreamAuthContext } from "./types.js";

// 最朴素的上游鉴权：配置里的 apiKey 作 Bearer。转发到任意 OpenAI/Anthropic 兼容网关时用。
export const apiKeyProvider: CredentialProvider = {
  mode: "api_key",
  supportsPath: () => true,
  async headers({ provider }: UpstreamAuthContext): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
    return headers;
  },
};
