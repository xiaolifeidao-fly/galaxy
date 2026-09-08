import type { ProviderConfig } from "../config/schema.js";
import type { Principal } from "../auth/principal.js";

// 上游凭据提供者：给一次 relay 请求算出要发给上游的鉴权/身份头。
// 每种 authMode 一个实现；新增一种上游（比如别家订阅）= 新增一个文件并在 index.ts 注册。
export interface UpstreamAuthContext {
  // 客户端请求头查询。用函数而不是 express Request：pool 模式下这次请求是从 Hub
  // 的工作单元里还原出来的，根本没有 express 对象，凭据层不该被传输方式绑住。
  header(name: string): string | undefined;
  principal: Principal;
  requestId: string;
  provider: ProviderConfig;
  providerName: string;
}

export interface CredentialProvider {
  readonly mode: ProviderConfig["authMode"] & string;
  // 这个 provider 接受哪些客户端路径；返回 false 时 relay 直接 400，不去碰凭据
  supportsPath(path: string): boolean;
  headers(ctx: UpstreamAuthContext): Promise<Record<string, string>>;
}
