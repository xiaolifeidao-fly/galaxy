// 通道层与节点 provider 之间的统一形状。这份类型与服务端 contract/galaxy.go 一一对应，
// 两侧同时改才算改完 —— 字段名不一致的后果是「单元派下来了但节点看不懂」。
//
// 目录结构照架构文档第 11.2 节的 galaxy/business/：core 放类型，每个 kind 一个目录，
// 契约（kind.yaml + JSON Schema）与节点 provider 各占一层。它落在 ai-bridge 里而不是
// galaxy/business/，是因为 ai-bridge 作为 Claude Code / Codex 插件是整目录分发的，
// 依赖插件目录之外的兄弟目录会让安装脚本装出一个跑不起来的插件。

export type Primitive = "relay" | "session" | "job";

export type MeterUnit =
  | "llm.input_tokens" | "llm.output_tokens" | "llm.cache_read_tokens"
  | "llm.cache_write_tokens" | "llm.calls" | "time.seconds"
  | "video.output_seconds" | "video.input_seconds" | "video.frames"
  | "gpu.seconds" | "cpu.seconds" | "storage.bytes" | "egress.bytes";

export type Metering = Partial<Record<MeterUnit, number>>;

export interface ArtifactRef {
  store: string;
  key: string;
  size?: number;
  sha256?: string;
  contentType?: string;
  expiresAt?: string;
  // url 是 Hub 现签的 presigned 地址，只在这一次下发里有效，不落盘。
  url?: string;
}

export interface Payload {
  name: string;
  // inline 从 Hub 下来时是 base64（Go 的 []byte 走 JSON 就是 base64）。
  inline?: string;
  ref?: ArtifactRef;
  contentType?: string;
}

export interface WorkUnit {
  id: string;
  kind: string;
  kindVersion: number;
  primitive: Primitive;
  family?: string;
  provider: string;
  model?: string;
  consumerKey: string;
  // space 是业务自己的空间。共享池按平台维度运行，这个字段只供业务回查。
  space?: string;
  // op 是 session 原语的子类型：open 第一回合、turn 同节点续跑、resume 跨节点续接。
  op?: "open" | "resume" | "turn" | "close";
  sid?: string;
  affinityKey?: string;
  hardPin?: string;
  cid?: string;
  seq?: number;
  attempt?: number;
  deadline?: number;
  inputs?: Payload[];
  outputs?: Payload[];
  metering?: { estimate?: Metering; actual?: Metering };
  state: string;
  createdAt?: number;
}

export type ErrorClass =
  | "input_fault" | "upstream_fault" | "node_fault"
  | "hub_fault" | "billing" | "protocol";

export interface UnitError {
  class: ErrorClass;
  code: string;
  retryable: boolean;
  message: string;
}

// provider.run 产出的事件。传输层只认这七种，业务再多也不会长出第八种。
export type UnitEvent =
  | { type: "head"; status: number; headers: Record<string, string> }
  | { type: "chunk"; bytes: Uint8Array }
  | { type: "progress"; pct: number; stage: string; previewRef?: ArtifactRef }
  | { type: "contextDelta"; delta: unknown }
  | { type: "artifact"; ref: ArtifactRef }
  | {
      type: "done";
      usage: Metering;
      // contextDelta 是 session 每个回合结束交给服务端账本的结构化增量。
      // 节点死了服务端仍要拥有完整业务上下文，靠的就是它（T-08）。
      contextDelta?: unknown;
      workspaceRef?: WorkspaceRef;
      checkpointRef?: ArtifactRef;
      // outputs 是 job 的产物引用。字节已经直传 OSS 了，这里只交引用。
      outputs?: Array<{ name: string; ref: ArtifactRef }>;
    }
  | { type: "error"; class: ErrorClass; code: string; retryable: boolean; message: string };

// WorkspaceRef 工作区层的位置：分支与 commit。跨节点续接时新节点 fetch 到这个 sha。
export interface WorkspaceRef {
  remote?: string;
  branch?: string;
  sha?: string;
}

export interface Resources {
  os: string;
  cpu: number;
  memGB: number;
  gpu: string | null;
  diskFreeGB: number;
  netMbps?: number;
}

// ProbeResult 是「本机有什么能力」的探测结果。它只供主人挑选，不会自动申报（P-02）。
export interface ProbeResult {
  resources: Resources;
  capabilities: Array<{
    kind: string;
    provider: string;
    available: boolean;
    detail?: string;
    // upstream 是 providers 里的配置键。provider 只是路由键（authMode 推出来的），
    // 两个 provider 可能推出同一个路由键，落成贡献时要靠 upstream 才知道借哪一份凭据。
    upstream?: string;
    // 这条能力实际会打到哪：本机正在用的中转站，或订阅官方。只在可用时有。
    upstreamTarget?: { baseURL: string; source: string };
  }>;
}

export interface UnitIO {
  // signal 在消费者断开或主人紧急停机时触发，provider 必须据此 abort 上游。
  signal: AbortSignal;
  log: (message: string, meta?: Record<string, unknown>) => void;
  // workDir 是这个单元的临时目录。运行循环在单元结束后整个删掉 ——
  // 消费者的素材不该在主人机器上留过夜（约束 4）。
  workDir?: string;
  // signArtifact 申请一个上传产物的地址。对象键由 Hub 生成：
  // 让节点自己起名等于把「对象键不含身份信息」交给不可信的一方去守。
  signArtifact?: (name: string, contentType: string, size: number) => Promise<ArtifactRef>;
  // progress 上报进度。取消信号搭在它的响应里回来（T-05）。
  progress?: (pct: number, stage: string, previewRef?: ArtifactRef) => Promise<{ cancelRequested: boolean }>;
}

// Provider 是节点侧真正干活的模块，按 (kind, provider) 装载。
// 未被贡献的 provider 不会被 import —— 主人没勾的能力，代码都不该加载（X-03）。
export interface Provider {
  kinds(): Array<{ kind: string; versions: number[]; provider: string }>;
  probe(): Promise<{ resources: Resources; upstreamOK: boolean; detail?: string }>;
  run(unit: WorkUnit, io: UnitIO): AsyncIterable<UnitEvent>;
  cancel?(unitId: string): Promise<void>;
}

// ---------- 工具 ----------

export function inlineInput(unit: WorkUnit, name: string): Buffer | undefined {
  const payload = unit.inputs?.find((item) => item.name === name && !item.ref);
  if (!payload?.inline) return undefined;
  return Buffer.from(payload.inline, "base64");
}

export function inlineText(unit: WorkUnit, name: string): string | undefined {
  return inlineInput(unit, name)?.toString("utf8");
}

export function inlineJSON<T>(unit: WorkUnit, name: string, fallback: T): T {
  const text = inlineText(unit, name);
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// modelMatch 与服务端 contract.ModelMatch 同语义：deny 优先，allow 为空表示不限。
// 两侧都要有这段逻辑：Hub 是路由权威，节点收单时必须再校验一次（原则 8）。
export function modelMatch(model: string, allow: string[] = [], deny: string[] = []): boolean {
  const hit = (pattern: string) => {
    const p = pattern.trim();
    if (!p) return false;
    if (p === "*") return true;
    return p.endsWith("*") ? model.startsWith(p.slice(0, -1)) : model === p;
  };
  if (deny.some(hit)) return false;
  return allow.length === 0 || allow.some(hit);
}
