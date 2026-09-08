import PQueue from "p-queue";
import type { AppConfig } from "../config/schema.js";
import { httpError } from "./errors.js";

export interface SubQueueStats {
  size: number;
  pending: number;
  concurrency: number;
  queueMaxSize: number;
}

export interface QueueStats {
  global: SubQueueStats;
  providers: Record<string, SubQueueStats>;
  principals: Record<string, { pending: number; concurrency: number }>;
}

interface SubQueue {
  q: PQueue;
  maxSize: number;
}

/**
 * 三层闸门：
 *   principal —— 每个调用方 token 自己的并发上限（可选），先挡住单个用户把大家拖垮
 *   provider  —— 每个上游独立队列，一家限流不连累别家
 *   global    —— 进程总并发上限，防止单机被打爆
 *
 * acquire 顺序：principal → provider → global；任一满/超时就 503。release 反向释放。
 */
export class ConcurrencyGate {
  private global: SubQueue;
  private providers = new Map<string, SubQueue>();
  private principals = new Map<string, { pending: number; limit: number }>();

  constructor(cfg: AppConfig) {
    this.global = {
      q: new PQueue({ concurrency: cfg.concurrency.global }),
      maxSize: cfg.concurrency.queueMaxSize,
    };
    for (const [name, pc] of Object.entries(cfg.providers)) {
      this.providers.set(name, {
        q: new PQueue({ concurrency: pc.concurrency ?? cfg.concurrency.global }),
        maxSize: pc.queueMaxSize ?? cfg.concurrency.queueMaxSize,
      });
    }
  }

  stats(): QueueStats {
    const out: QueueStats = { global: snapshot(this.global), providers: {}, principals: {} };
    for (const [name, sub] of this.providers) out.providers[name] = snapshot(sub);
    for (const [alias, s] of this.principals) {
      if (s.pending > 0) out.principals[alias] = { pending: s.pending, concurrency: s.limit };
    }
    return out;
  }

  async acquire(opts: {
    providerName: string;
    principalAlias?: string;
    principalLimit?: number;
    waitTimeoutMs: number;
    signal: AbortSignal;
  }): Promise<() => void> {
    const { providerName, principalAlias, principalLimit, waitTimeoutMs, signal } = opts;
    const sub = this.providers.get(providerName);
    if (!sub) throw httpError(500, "unknown_provider", `provider not found: ${providerName}`);

    // principal 层：不排队，超了直接 429（这是调用方自己的配额）
    let releasePrincipal: (() => void) | null = null;
    if (principalAlias && principalLimit) {
      const s = this.principals.get(principalAlias) ?? { pending: 0, limit: principalLimit };
      s.limit = principalLimit;
      if (s.pending >= s.limit) {
        throw httpError(429, "principal_concurrency_exceeded", `too many concurrent requests for "${principalAlias}"`);
      }
      s.pending++;
      this.principals.set(principalAlias, s);
      releasePrincipal = () => {
        s.pending = Math.max(0, s.pending - 1);
        if (s.pending === 0) this.principals.delete(principalAlias);
      };
    }

    try {
      if (sub.q.size >= sub.maxSize) throw httpError(503, "queue_full", `provider ${providerName} queue full`);
      if (this.global.q.size >= this.global.maxSize) throw httpError(503, "queue_full", "global queue full");

      const releaseProvider = await acquireOne(sub, providerName, waitTimeoutMs, signal);
      let releaseGlobal: (() => void) | null = null;
      try {
        releaseGlobal = await acquireOne(this.global, "global", waitTimeoutMs, signal);
      } catch (e) {
        releaseProvider();
        throw e;
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseGlobal!();
        releaseProvider();
        releasePrincipal?.();
      };
    } catch (e) {
      releasePrincipal?.();
      throw e;
    }
  }

  async onIdle(): Promise<void> {
    await Promise.all([
      this.global.q.onIdle(),
      ...[...this.providers.values()].map((s) => s.q.onIdle()),
    ]);
  }
}

function snapshot(s: SubQueue): SubQueueStats {
  return { size: s.q.size, pending: s.q.pending, concurrency: s.q.concurrency, queueMaxSize: s.maxSize };
}

async function acquireOne(
  sub: SubQueue,
  label: string,
  waitTimeoutMs: number,
  signal: AbortSignal
): Promise<() => void> {
  let release!: () => void;
  let onAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => (onAcquired = resolve));

  sub.q
    .add(
      () =>
        new Promise<void>((resolveTask) => {
          release = resolveTask;
          onAcquired();
        }),
      { signal }
    )
    .catch(() => onAcquired());

  try {
    await Promise.race([
      acquired,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(httpError(503, "queue_wait_timeout", `${label} queue wait timeout`)),
          waitTimeoutMs
        ).unref()
      ),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  } catch (e) {
    if (typeof release === "function") release();
    throw e;
  }

  return () => release();
}
