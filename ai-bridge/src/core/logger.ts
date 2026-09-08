// 结构化日志，零依赖。level 由 LOG_LEVEL 或 config.log.level 决定。
// 约定：任何日志 meta 里都不放 token / 凭据原文，最多放 alias 或前缀。
export type LogLevel = "debug" | "info" | "warn" | "error";
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
let sink: (line: string, level: LogLevel) => void = (line, level) => {
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(line + "\n");
};

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}
export function setLogSink(fn: typeof sink) {
  sink = fn;
}

function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
  if (order[level] < order[minLevel]) return;
  const line = { time: new Date().toISOString(), level, msg, ...meta };
  sink(JSON.stringify(line), level);
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
  // 带固定字段的子 logger（如 requestId / module）
  child(base: Record<string, unknown>) {
    return {
      debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, { ...base, ...meta }),
      info: (m: string, meta?: Record<string, unknown>) => emit("info", m, { ...base, ...meta }),
      warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, { ...base, ...meta }),
      error: (m: string, meta?: Record<string, unknown>) => emit("error", m, { ...base, ...meta }),
    };
  },
};
export type Logger = typeof log;
