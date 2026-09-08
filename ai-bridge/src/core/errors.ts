// 桥接服务内部统一的 HTTP 错误：status + code + message。
// 各协议的错误体形态（OpenAI / Anthropic）由路由层的 errorBody 决定，这里只表达语义。
export class BridgeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function httpError(status: number, code: string, message: string, details?: unknown): BridgeError {
  return new BridgeError(status, code, message, details);
}

// 统一错误体：OpenAI SDK 读 error.message/type/code，Anthropic SDK 读 type:"error" + error.type/message，
// 一个形态同时满足两边。模块内部若有更精确的协议形态可自行覆盖。
export function errorBody(status: number, code: string, message: string) {
  return { type: "error", error: { type: code, code, message, status } };
}

// 从任意抛出的值里提取 status/code/message，兼容 BridgeError 与手工挂了字段的 Error
export function describeError(e: unknown): { status: number; code: string; message: string } {
  const any = e as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown } | undefined;
  const statusRaw = any?.status ?? any?.statusCode;
  const status = typeof statusRaw === "number" && statusRaw >= 400 && statusRaw < 600 ? statusRaw : 500;
  const code = typeof any?.code === "string" && any.code ? any.code : "internal_error";
  const message = typeof any?.message === "string" && any.message ? any.message : "internal error";
  return { status, code, message };
}
