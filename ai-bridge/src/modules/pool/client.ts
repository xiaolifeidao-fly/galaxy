import { Readable } from "node:stream";
import { log } from "../../core/logger.js";
import { httpError } from "../../core/errors.js";
import type { ArtifactRef, Metering, UnitError, WorkUnit } from "../../business/core/index.js";

// Hub 的三端点客户端。节点主动出站，Hub 永不主动连节点（T-01）。
//
// 传输是「长轮询领活 + chunked 上行 + 短请求报终态」，帧语义与传输解耦：
// 将来换 WebSocket 只要换掉这个文件（T-06）。

export interface HubLane {
  cid: string;
  free: number;
}

export interface HeartbeatLane {
  cid: string;
  inflight: number;
  queued: number;
  quotaLeft?: Metering;
  throttledUntil?: string | null;
  upstreamOK?: boolean;
  paused?: boolean;
  cachedArtifacts?: string[];
}

export interface HeartbeatResult {
  cancel: string[];
  drain: string[];
  quotaUpdate: Record<string, Metering>;
  serverTime: number;
  // enabled 是主人在控制台定下的生效配置，搭在心跳上下发。
  // **可选是有意义的**：字段缺失表示对面是老版本 Hub，节点应当维持现状；
  // 空数组才表示「一条都别跑」。两者混同会让一次版本不匹配把所有通道停掉。
  enabled?: EnabledContribution[];
}

export interface NextResult {
  unit: WorkUnit;
  lease: { token: string; expiresAt: number; renewSec: number };
  streamURL: string;
  cancel: string[];
}

/**
 * 上报给 Hub 的一项**本机能力**。
 *
 * 注意它不再带座位、额度、模型范围 —— 那些是「共享多少」，由主人在控制台定，
 * 节点报什么都不作数。这里只回答「这台机器有什么、现在能不能干」。
 */
export interface CapabilityReport {
  cid: string;
  kind: string;
  kindVersion: number;
  provider: string;
  available: boolean;
  unavailableReason?: string;
}

/**
 * Hub 下发的**生效配置**：主人开着、且本机报了可用的那些能力，连同座位、
 * 额度、模型范围和挂机时段。节点按它建通道。
 */
export interface EnabledContribution {
  cid: string;
  kind: string;
  kindVersion: number;
  provider: string;
  modelsAllow: string[];
  modelsDeny: string[];
  seats: number;
  seatConcurrency: number;
  quota: Array<{ unit: string; limit: number; window: string; resetAt?: string }>;
  schedule: Array<{ from: string; to: string; tz?: string }>;
}

export class ContractMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractMismatchError";
  }
}

export class HubClient {
  constructor(
    private readonly baseURL: string,
    private readonly contractVersion: number,
    private token?: string,
    private nodeId?: string,
  ) {}

  setIdentity(nodeId: string, token: string) {
    this.nodeId = nodeId;
    this.token = token;
  }

  private url(path: string): string {
    return this.baseURL.replace(/\/+$/, "") + path;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-galaxy-contract": String(this.contractVersion),
      ...extra,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.nodeId) headers["x-galaxy-node"] = this.nodeId;
    return headers;
  }

  // pair 用一次性配对码换长期节点令牌。明文只在这一次返回。
  async pair(code: string, displayName: string, bridgeVersion: string): Promise<{ nodeId: string; token: string }> {
    const response = await fetch(this.url("/agent/v1/pair"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-galaxy-contract": String(this.contractVersion) },
      body: JSON.stringify({ code, displayName, bridgeVersion }),
    });
    const payload = await readJSON(response);
    if (!response.ok) throw hubError(response.status, payload);
    return payload as { nodeId: string; token: string };
  }

  // hello 是全量替换：这次没申报的贡献，Hub 立刻看不到。
  async hello(body: {
    bridgeVersion: string;
    contract: number;
    resources: unknown;
    contributions: CapabilityReport[];
  }): Promise<{
    accepted: string[];
    rejected: Array<{ cid: string; reason: string }>;
    quotaEffective: Record<string, unknown>;
    enabled?: EnabledContribution[];
  }> {
    const response = await fetch(this.url("/agent/v1/hello"), {
      method: "POST", headers: this.headers(), body: JSON.stringify(body),
    });
    const payload = await readJSON(response);
    if (response.status === 426) {
      throw new ContractMismatchError(messageOf(payload) ?? "契约版本不一致，请升级 ai-bridge");
    }
    if (!response.ok) throw hubError(response.status, payload);
    return payload as never;
  }

  async heartbeat(lanes: HeartbeatLane[]): Promise<HeartbeatResult> {
    const response = await fetch(this.url("/agent/v1/heartbeat"), {
      method: "POST", headers: this.headers(), body: JSON.stringify({ lanes }),
    });
    const payload = await readJSON(response);
    if (!response.ok) throw hubError(response.status, payload);
    return payload as HeartbeatResult;
  }

  // next 长轮询。204 表示这一轮没活，立刻再来一轮。
  async next(lanes: HubLane[], waitSeconds: number, signal: AbortSignal): Promise<NextResult | undefined> {
    // POST 而不是 GET：通道列表在请求体里，而 fetch 规范明令 GET/HEAD 不能带 body
    // （undici 直接拒 "Request with GET/HEAD method cannot have body."，
    // duplex: "half" 也救不回来）。领活会占租约、扣并发，本来也不是只读操作。
    const response = await fetch(this.url(`/agent/v1/next?waitSeconds=${waitSeconds}`), {
      method: "POST", headers: this.headers(), body: JSON.stringify({ lanes }), signal,
    });
    if (response.status === 204) return undefined;
    const payload = await readJSON(response);
    if (!response.ok) throw hubError(response.status, payload);
    return payload as NextResult;
  }

  // stream 上行推流。一次响应一条连接，边收上游边推，背压顺着这条连接顶回上游。
  // 返回 410 表示消费者已经走了，调用方必须立刻 abort 上游。
  async stream(streamURL: string, options: {
    status: number;
    headers: Record<string, string>;
    lease: string;
    body: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
  }): Promise<{ ok: boolean; consumerGone: boolean }> {
    const response = await fetch(streamURL, {
      method: "POST",
      headers: {
        ...this.headers({ "content-type": "application/octet-stream" }),
        "x-galaxy-lease": options.lease,
        "x-galaxy-upstream-status": String(options.status),
        "x-galaxy-upstream-headers": Buffer.from(JSON.stringify(options.headers), "utf8").toString("base64"),
      },
      body: Readable.toWeb(Readable.from(options.body)) as ReadableStream,
      duplex: "half",
      signal: options.signal,
    } as RequestInit & { duplex: "half" });
    if (response.status === 410) {
      await response.body?.cancel();
      return { ok: false, consumerGone: true };
    }
    const payload = await readJSON(response);
    if (!response.ok) {
      log.warn("pool_stream_rejected", { status: response.status, message: messageOf(payload) });
      return { ok: false, consumerGone: false };
    }
    return { ok: true, consumerGone: false };
  }

  // signArtifact 申请上传产物的地址。GB 级产物直传 OSS，Hub 不经手字节（约束 3）。
  async signArtifact(unitId: string, body: { name: string; contentType: string; size: number }): Promise<ArtifactRef> {
    const response = await fetch(this.url(`/agent/v1/units/${unitId}/artifacts`), {
      method: "POST", headers: this.headers(), body: JSON.stringify(body),
    });
    const payload = await readJSON(response);
    if (!response.ok) throw hubError(response.status, payload);
    return payload as ArtifactRef;
  }

  async progress(unitId: string, body: { lease: string; seq?: number; progress?: unknown; renew?: boolean }): Promise<{ cancelRequested: boolean }> {
    const response = await fetch(this.url(`/agent/v1/units/${unitId}/progress`), {
      method: "POST", headers: this.headers(), body: JSON.stringify(body),
    });
    const payload = await readJSON(response);
    if (!response.ok) throw hubError(response.status, payload);
    return payload as { cancelRequested: boolean };
  }

  async complete(unitId: string, body: {
    lease: string;
    state: "completed" | "failed" | "cancelled";
    error?: UnitError | null;
    usage?: Metering;
    // session 的回合终态：上下文增量与工作区位置交给服务端账本，
    // 这台机器明天不在了，业务上下文还在（T-08）。
    contextDelta?: unknown;
    workspaceRef?: unknown;
    checkpointRef?: unknown;
    // outputs 是 job 的产物引用。字节已经直传 OSS，这里只交引用。
    outputs?: Array<{ name: string; ref: ArtifactRef }>;
    ms?: number;
  }): Promise<void> {
    const response = await fetch(this.url(`/agent/v1/units/${unitId}/complete`), {
      method: "POST", headers: this.headers(), body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await readJSON(response);
      log.warn("pool_complete_rejected", { unitId, status: response.status, message: messageOf(payload) });
    }
  }
}

async function readJSON(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 512) };
  }
}

function messageOf(payload: unknown): string | undefined {
  const value = payload as { message?: unknown; error?: unknown };
  if (typeof value?.message === "string") return value.message;
  if (typeof value?.error === "string") return value.error;
  return undefined;
}

function hubError(status: number, payload: unknown) {
  return httpError(status, "hub_rejected", messageOf(payload) ?? `Hub 返回 ${status}`);
}
