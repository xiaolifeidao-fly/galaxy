import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log } from "./logger.js";

export type RawBodyRequest = Request & { rawBody?: Buffer };

// 上游响应里原样带回给客户端的头（限流/重试提示与请求追踪）
const PASSTHROUGH_RESPONSE_HEADERS = new Set(["request-id", "retry-after", "x-should-retry"]);
function shouldPassthroughHeader(name: string): boolean {
  return PASSTHROUGH_RESPONSE_HEADERS.has(name) || name.startsWith("anthropic-ratelimit-") || name.startsWith("x-ratelimit-");
}

// 纯透传：把客户端请求原样转发到上游模型 API，再把上游响应（含 SSE 流）原样写回。
// 请求体与响应不做协议转换，工具调用始终交给客户端。
export async function proxyRelay(opts: {
  req: Request;
  res: Response;
  baseURL: string;                       // 上游前缀，可带 path（如 https://chatgpt.com/backend-api/codex）
  authHeaders: Record<string, string>;   // 鉴权及上游所需的额外头
  signal: AbortSignal;
  requestId: string;
  idleTimeoutMs?: number;
}): Promise<{ status: number }> {
  const { req, res, baseURL, authHeaders, signal, requestId } = opts;

  // 路径拼接：剥掉客户端的 /v1 前缀，接到上游 baseURL 后面。
  //   anthropic: baseURL=.../v1                + /messages   → .../v1/messages
  //   chatgpt:   baseURL=/backend-api/codex    + /responses  → /backend-api/codex/responses
  const base = baseURL.replace(/\/+$/, "");
  const subPath = req.path.replace(/^\/v1(?=\/)/, "");
  const qsIdx = req.originalUrl.indexOf("?");
  const qs = qsIdx >= 0 ? req.originalUrl.slice(qsIdx) : "";
  const url = base + subPath + qs;

  // 只带白名单头：客户端的 authorization / x-api-key / cookie 一律不转发
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: req.header("accept") || "text/event-stream",
    ...authHeaders,
  };

  const rawBody = (req as RawBodyRequest).rawBody;
  const body = rawBody ? new Uint8Array(rawBody) : JSON.stringify(req.body ?? {});
  log.debug("relay_forward", { requestId, url, bytes: body.length });

  const relayAbort = new AbortController();
  const onAbort = () => relayAbort.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (opts.idleTimeoutMs) {
      idleTimer = setTimeout(() => relayAbort.abort(Object.assign(new Error("relay upstream idle timeout"), {
        status: 504, code: "stream_idle_timeout",
      })), opts.idleTimeoutMs);
      idleTimer.unref();
    }
  };
  resetIdle();
  try {
    const upstream = await fetch(url, { method: "POST", headers, body, signal: relayAbort.signal, redirect: "error" });

    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    upstream.headers.forEach((value, name) => {
      if (shouldPassthroughHeader(name)) res.setHeader(name, value);
    });
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    if (!upstream.body) {
      res.end();
      return { status: upstream.status };
    }

    const source = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
    async function* chunks() {
      for await (const chunk of source) {
        resetIdle();
        yield chunk;
      }
    }
    // pipeline 处理背压及客户端断开；上游中途断流时销毁响应，避免伪装为正常完成。
    await pipeline(chunks(), res, { signal: relayAbort.signal });
    return { status: upstream.status };
  } catch (e) {
    throw relayAbort.signal.aborted ? relayAbort.signal.reason : e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal.removeEventListener("abort", onAbort);
  }
}
