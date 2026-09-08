import type { Request, RequestHandler, Response } from "express";
import type { BridgeContext } from "../types.js";
import type { AdapterRegistry } from "./adapters/registry.js";
import type { ChatChunk, ChatRequest } from "./adapters/types.js";
import { streamWithRetry } from "../../core/retry.js";
import { beginRequest } from "../../core/request.js";
import { describeError } from "../../core/errors.js";
import { getPrincipal } from "../../auth/principal.js";

// 一种客户端协议在 agent 模式下的绑定：怎么解析进来、怎么写出去。
export interface ProtocolBinding {
  parse: (body: unknown) => ChatRequest;
  writeStream: (res: Response, model: string, stream: AsyncIterable<ChatChunk>) => Promise<void>;
  writeJson: (res: Response, model: string, stream: AsyncIterable<ChatChunk>) => Promise<void>;
  errorBody: (status: number, code: string, message: string) => unknown;
  writeSSEHeaders: (res: Response) => void;
}

export function makeAgentHandler(ctx: BridgeContext, registry: AdapterRegistry, binding: ProtocolBinding): RequestHandler {
  return async function agentHandler(req: Request, res: Response) {
    const lifecycle = beginRequest(req, res, ctx.cfg.server);
    const { requestId, signal } = lifecycle;
    const principal = getPrincipal(req)!;
    let release: (() => void) | null = null;
    let sseStarted = false;

    const sendError = (status: number, code: string, message: string) => {
      if (res.destroyed || res.writableEnded) return;
      if (sseStarted) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ code, message })}\n\n`); } catch { /* ignore */ }
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      res.status(status).json(binding.errorBody(status, code, message));
    };

    try {
      let internal: ChatRequest;
      try {
        internal = binding.parse(req.body);
      } catch (e) {
        return sendError(400, "invalid_request", (e as Error)?.message ?? "invalid request body");
      }

      const route = registry.resolve(internal.model);
      const upstreamReq: ChatRequest = { ...internal, model: route.upstreamModel };

      release = await ctx.gate.acquire({
        providerName: route.providerName,
        principalAlias: principal.alias,
        principalLimit: principal.concurrency,
        waitTimeoutMs: ctx.cfg.server.queueWaitTimeoutMs,
        signal,
      });

      ctx.log.info("agent_start", {
        requestId, alias: principal.alias, clientModel: internal.model,
        upstreamModel: route.upstreamModel, provider: route.providerName, stream: internal.stream,
      });

      const upstreamStream = streamWithRetry(ctx.cfg.retry, signal, () =>
        route.adapter.chatStream(upstreamReq, { signal, requestId })
      );

      if (internal.stream) {
        binding.writeSSEHeaders(res);
        sseStarted = true;
        await pipeWithIdleGuard(upstreamStream, ctx.cfg.server.streamIdleTimeoutMs, signal,
          (s) => binding.writeStream(res, internal.model, s));
      } else {
        await binding.writeJson(res, internal.model, upstreamStream);
      }
      ctx.log.info("agent_done", { requestId, alias: principal.alias });
    } catch (e) {
      const { status, code, message } = describeError(e);
      ctx.log.warn("agent_error", { requestId, alias: principal.alias, status, code, message });
      sendError(status, code, message);
    } finally {
      lifecycle.dispose();
      release?.();
    }
  };
}

// SSE 相邻 chunk 间隔守护：超过 idleMs 没新 chunk → 抛错
async function pipeWithIdleGuard<T>(
  src: AsyncIterable<T>,
  idleMs: number,
  signal: AbortSignal,
  consume: (s: AsyncIterable<T>) => Promise<void>
) {
  const iter = src[Symbol.asyncIterator]();

  async function* guarded(): AsyncIterable<T> {
    while (true) {
      let timer: NodeJS.Timeout | null = null;
      try {
        const result = await Promise.race([
          iter.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(Object.assign(new Error("Stream idle timeout"), { status: 504, code: "stream_idle_timeout" }));
            }, idleMs);
          }),
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (result.done) return;
        yield result.value;
      } catch (e) {
        if (timer) clearTimeout(timer);
        try { await iter.return?.(undefined); } catch { /* ignore */ }
        throw e;
      }
    }
  }

  await consume(guarded());
}
