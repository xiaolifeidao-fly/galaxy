import { z } from "zod";

// ---------- 上游 provider ----------
// relay              = 纯透传：把请求原样转发到上游模型 API，桥接不解析、不执行工具。
// codex_local        = 在桥接所在机器跑 codex agent（会执行命令、写文件），属 agent 模块。
// claude_code_local  = 在桥接所在机器跑 Claude Code agent，属 agent 模块。
export const ProviderTypeSchema = z.enum(["relay", "codex_local", "claude_code_local"]);

// relay 的上游鉴权方式（对应 src/credentials 下的一个 CredentialProvider）：
//   codex_chatgpt = 本机 codex 订阅登录态（~/.codex/auth.json）直连 ChatGPT 后端
//   claude_oauth  = 本机 Claude Code 订阅登录态，转发 Anthropic Messages
//   api_key       = 用 apiKey 作 Bearer（转发到任意兼容 API）
export const AuthModeSchema = z.enum(["codex_chatgpt", "claude_oauth", "api_key"]);

export const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema,
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  authMode: AuthModeSchema.optional(),
  // codex_chatgpt: auth.json 路径；claude_oauth: .credentials.json 路径
  authFile: z.string().optional(),
  // claude_oauth：自定义 Claude 配置目录时可显式指定 Keychain service；authFile 优先于自动发现
  claudeKeychainService: z.string().min(1).optional(),
  // 上游可用的模型清单。写了就以它为准、不去打上游的 /models；
  // 用于那些没有 models 端点的上游（如 Codex 的 chatgpt.com/backend-api/codex）。
  models: z.array(z.string().min(1)).optional(),
  // 仅作用于该 provider 的并发上限；不填走全局
  concurrency: z.number().int().positive().optional(),
  queueMaxSize: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  // 仅 codex_local
  codex: z
    .object({
      codexPathOverride: z.string().optional(),
      workingDirectory: z.string().optional(),
      sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
      approvalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]).optional(),
      skipGitRepoCheck: z.boolean().optional(),
      extraConfig: z.record(z.unknown()).optional(),
      defaultReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
    })
    .optional(),
  // 仅 claude_code_local
  claudeCode: z
    .object({
      cwd: z.string().optional(),
      permissionMode: z
        .enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])
        .optional(),
      additionalDirectories: z.array(z.string()).optional(),
      allowedTools: z.array(z.string()).optional(),
      disallowedTools: z.array(z.string()).optional(),
      toolsPreset: z.enum(["claude_code", "none"]).optional(),
      systemPrompt: z.string().optional(),
      maxTurns: z.number().int().positive().optional(),
    })
    .optional(),
});

// ---------- 访问控制 ----------
// scope 决定一个 token 能碰哪些模块。"*" 是全部。
export const SCOPES = ["relay:anthropic", "relay:openai", "agent", "admin", "*"] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

// 单个访问凭据。token（明文）和 tokenHash（sha256 hex）二选一；
// alias 用于日志/审计与 CLI 操作，必须唯一。
export const AuthTokenSchema = z
  .object({
    token: z.string().min(8).optional(),
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    alias: z.string().min(1).regex(/^[A-Za-z0-9_.:-]+$/),
    scopes: z.array(ScopeSchema).min(1).default(["relay:anthropic", "relay:openai"]),
    // 该 token 同时在跑的请求上限；不填不限（仍受全局/provider 闸门约束）
    concurrency: z.number().int().positive().optional(),
    disabled: z.boolean().default(false),
  })
  .refine((t) => !!t.token !== !!t.tokenHash, { message: "token 与 tokenHash 必须且只能填一个" });

export const AuthConfigSchema = z.object({
  // 关掉后所有请求都当 anonymous、拥有全部 scope。仅本机自用、且监听 127.0.0.1 时才这样配。
  enabled: z.boolean().default(true),
  // 内联 token；多人共享建议改用 tokenFile + CLI 生成哈希 token
  tokens: z.array(AuthTokenSchema).default([]),
  // CLI `ai-bridge token add` 维护的文件；不填走 <runtimeDir>/tokens.json
  tokenFile: z.string().optional(),
  // 允许访问的来源 IP/CIDR，空 = 不限制。示例："127.0.0.1"、"10.0.0.0/8"、"::1"
  ipAllowlist: z.array(z.string().min(1)).default([]),
  // /admin/* 是否只允许 loopback 来源（即便带了 admin scope）
  adminLoopbackOnly: z.boolean().default(true),
});

// ---------- 模块 ----------
export const RelayConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // /v1/messages、/v1/messages/count_tokens 走哪个 provider（必须 type=relay 且有 baseURL）
  anthropic: z.string().min(1).optional(),
  // /v1/responses、/v1/chat/completions 走哪个 provider
  openai: z.string().min(1).optional(),
});

export const ModelRouteSchema = z.object({
  match: z.string().min(1),
  provider: z.string().min(1),
  rewriteTo: z.string().optional(),
});

export const AgentConfigSchema = z.object({
  // 默认关：开了意味着桥接所在机器会替客户端执行命令、写文件
  enabled: z.boolean().default(false),
  // 请求带这个头（值非空）时才走 agent；否则同一路径走 relay
  header: z.string().min(1).default("x-ai-agent"),
  // 顺序匹配，命中即用；支持 * 通配
  routes: z.array(ModelRouteSchema).default([]),
});

export const AdminConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

// ---------- 共享算力池（pool 模式） ----------
// pool 模式下节点不监听任何端口，只主动出站连 Hub（P-15）：攻击面只剩「主动连了谁」。

export const PoolQuotaSchema = z.object({
  // 计量单位，如 llm.output_tokens / time.seconds / llm.calls
  unit: z.string().min(1),
  limit: z.number().int().positive(),
  window: z.enum(["day", "week", "month", "total"]).default("day"),
  // 归零时刻与时区偏移，如 "00:00+08:00"；不填按 UTC 零点
  resetAt: z.string().optional(),
});

export const PoolScheduleSchema = z.object({
  // "22:00-08:00" 这种区间；跨零点合法
  window: z.string().regex(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/),
  tz: z.string().optional(),
});

// ExecSpec 本机执行器：agent 回合、ffmpeg 渲染这类「在主人机器上跑命令」的能力用它。
//
// 进程协议固定：stdin 收一个 JSON，stdout 吐 NDJSON 事件流。
// 换执行器只要换命令，不用改代码 —— 也意味着这条命令能干什么，
// 完全取决于主人自己写了什么，Hub 无权也无法指定。
export const PoolExecSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

// 一条贡献 = 主人勾选出去共享的一种能力。
//
// **这一段已经不再决定任何事。** 共享哪几种、共享多少、座位、模型范围、挂机时段，
// 现在全部由主人在 Galaxy 控制台的「贡献授权」里定，Hub 每次 hello / 心跳下发一份
// 生效配置，节点照着建通道。留着这个 schema 是为了让老配置文件还能解析通过，
// 以及 pool status 还能打印出来看 —— 但节点启动时不会再读它。
//
// 这么改的理由：主人想调整时不该被逼回到那台机器上。
export const PoolContributionSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9_.:-]+$/),
  kind: z.string().min(1).default("llm.chat"),
  kindVersion: z.number().int().positive().default(1),
  // upstream 引用 providers 里的一项。路由键 provider 由它的 authMode 推出来，
  // 主人不需要在两个地方各写一遍「这是 Claude 还是 Codex」。
  // 只有中转类能力（llm.chat）需要它；本机执行类能力用 exec。
  upstream: z.string().min(1).optional(),
  exec: PoolExecSchema.optional(),
  // provider 是路由键。中转类由 upstream 的 authMode 推出来，本机执行类在这里显式写。
  provider: z.string().min(1).optional(),
  models: z.object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }).default({}),
  // 同时服务的消费者数量上限，以及单座位并发
  seats: z.number().int().positive().default(3),
  seatConcurrency: z.number().int().positive().default(2),
  // 三维额度：三者同时生效，任一触顶停止接单
  quota: z.array(PoolQuotaSchema).min(1),
  schedule: z.array(PoolScheduleSchema).default([]),
  enabled: z.boolean().default(true),
});

export const PoolConfigSchema = z.object({
  hubURL: z.string().url(),
  // 节点令牌落盘位置；不填走 <runtimeDir>/node-token.json
  tokenFile: z.string().optional(),
  heartbeatSec: z.number().int().positive().default(15),
  nextWaitSec: z.number().int().min(1).max(30).default(25),
  // 契约版本。与 Hub 不一致时 hello 被拒，节点停止重试并提示升级（S-11）。
  contract: z.number().int().positive().default(1),
  contributions: z.array(PoolContributionSchema).default([]),
});

export const AppConfigSchema = z.object({
  // relay = 本机监听、给本机客户端用；pool = 不监听、把算力贡献给共享池。两者互斥。
  mode: z.enum(["relay", "pool"]).default("relay"),
  pool: PoolConfigSchema.optional(),
  server: z
    .object({
      // 默认只监听本机。要给别的机器用，显式改 0.0.0.0 并配 auth.ipAllowlist
      host: z.string().default("127.0.0.1"),
      // 0 = 随机端口（测试用）
      port: z.number().int().min(0).max(65535).default(8787),
      requestTimeoutMs: z.number().int().positive().default(600_000),
      queueWaitTimeoutMs: z.number().int().positive().default(30_000),
      streamIdleTimeoutMs: z.number().int().positive().default(60_000),
      shutdownTimeoutMs: z.number().int().positive().default(30_000),
      bodyLimit: z.string().default("4mb"),
      // 在反向代理后面时打开，req.ip 才会取 X-Forwarded-For
      trustProxy: z.boolean().default(false),
    })
    .default({}),
  log: z
    .object({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .default({}),
  concurrency: z
    .object({
      global: z.number().int().positive().default(32),
      queueMaxSize: z.number().int().positive().default(256),
    })
    .default({}),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).default(3),
      baseDelayMs: z.number().int().positive().default(500),
      maxDelayMs: z.number().int().positive().default(8_000),
    })
    .default({}),
  auth: AuthConfigSchema.default({}),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  relay: RelayConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  admin: AdminConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type AuthToken = z.infer<typeof AuthTokenSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelRoute = z.infer<typeof ModelRouteSchema>;
export type RelayConfig = z.infer<typeof RelayConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type PoolConfig = z.infer<typeof PoolConfigSchema>;
export type PoolContribution = z.infer<typeof PoolContributionSchema>;
export type PoolQuota = z.infer<typeof PoolQuotaSchema>;
export type PoolExec = z.infer<typeof PoolExecSchema>;
