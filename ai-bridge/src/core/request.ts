import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/schema.js";

// 每个业务请求共享的生命周期：requestId、取消信号（客户端断开 / 总超时）。
// handler 用 `using`-风格：拿到 ctx，finally 里 ctx.dispose()。
export interface RequestLifecycle {
  requestId: string;
  signal: AbortSignal;
  dispose(): void;
}

export function beginRequest(req: Request, res: Response, cfg: AppConfig["server"]): RequestLifecycle {
  const requestId = (req.header("x-request-id") || randomUUID()).slice(0, 64);
  res.setHeader("x-request-id", requestId);

  const ac = new AbortController();
  // 用 res.on("close") 而不是 req.on("close")：req 是 Readable，body 解析完后也会 emit close，
  // 会被误判成客户端断开。res.close 只在响应发完或连接异常关闭时触发；用 writableEnded 区分。
  const onClose = () => {
    if (res.writableEnded) return;
    if (!ac.signal.aborted) ac.abort(Object.assign(new Error("client_closed"), { code: "client_closed", status: 499 }));
  };
  res.on("close", onClose);
  const timer = setTimeout(() => {
    ac.abort(Object.assign(new Error("request timeout"), { status: 504, code: "request_timeout" }));
  }, cfg.requestTimeoutMs);
  timer.unref();

  return {
    requestId,
    signal: ac.signal,
    dispose() {
      clearTimeout(timer);
      res.off("close", onClose);
    },
  };
}
