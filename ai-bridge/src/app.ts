import express, { type ErrorRequestHandler, type Express } from "express";
import http from "node:http";
import type { AppConfig } from "./config/schema.js";
import { log, setLogLevel } from "./core/logger.js";
import { describeError, errorBody } from "./core/errors.js";
import { ConcurrencyGate } from "./core/queue.js";
import { CredentialRegistry } from "./credentials/index.js";
import { makeAuth, TokenStore, resolveTokenFile } from "./auth/index.js";
import { builtinModules, ModuleRegistry, type BridgeContext, type BridgeModule } from "./modules/index.js";
import type { RawBodyRequest } from "./core/proxy.js";

export interface Bridge {
  app: Express;
  server: http.Server;
  ctx: BridgeContext;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export interface CreateBridgeOptions {
  cfg: AppConfig;
  env?: NodeJS.ProcessEnv;
  // 测试或扩展时可以替换/追加模块
  modules?: (getRegistry: () => ModuleRegistry) => BridgeModule[];
}

// 把配置装配成一个可监听的 HTTP 服务。不读文件、不碰 process 信号——那些在 main.ts。
export async function createBridge(opts: CreateBridgeOptions): Promise<Bridge> {
  const { cfg } = opts;
  const env = opts.env ?? process.env;
  setLogLevel(cfg.log.level);

  const tokenFile = resolveTokenFile(cfg.auth, env);
  const tokens = new TokenStore(cfg.auth, tokenFile);
  await tokens.load();
  const auth = makeAuth(cfg.auth, tokens);
  const gate = new ConcurrencyGate(cfg);
  const credentials = new CredentialRegistry();

  let shuttingDown = false;
  let registry!: ModuleRegistry;
  const ctx: BridgeContext = {
    cfg, log, gate, credentials, auth, tokens, tokenFile,
    isShuttingDown: () => shuttingDown,
    shared: {},
  };
  registry = new ModuleRegistry((opts.modules ?? builtinModules)(() => registry));
  await registry.init(ctx);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", cfg.server.trustProxy);
  app.use(express.json({
    limit: cfg.server.bodyLimit,
    verify: (req, _res, buffer) => { (req as RawBodyRequest).rawBody = buffer; },
  }));
  // socket 级别的总超时兜底
  app.use((_req, res, next) => {
    res.setTimeout(cfg.server.requestTimeoutMs, () => {
      if (!res.headersSent) {
        res.status(504).json(errorBody(504, "request_timeout", "request timeout"));
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
    next();
  });

  registry.mount(app, ctx);

  app.use((req, res) => {
    log.warn("route_not_found", { method: req.method, path: req.path });
    res.status(404).json(errorBody(404, "not_found", "route not found"));
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const { status, code, message } = describeError(err);
    if (status >= 500) log.error("unhandled_error", { code, message, stack: (err as Error)?.stack });
    if (res.headersSent) {
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    // body-parser 的错误（JSON 坏了 / 超大）挂的是 type 而不是 code
    const bp = err as { type?: string };
    if (bp?.type === "entity.too.large") return res.status(413).json(errorBody(413, "payload_too_large", message));
    if (bp?.type === "entity.parse.failed") return res.status(400).json(errorBody(400, "invalid_json", message));
    res.status(status).json(errorBody(status, code, message));
  };
  app.use(onError);

  const server = http.createServer(app);
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  server.requestTimeout = 0; // 走我们自己的 res.setTimeout

  return {
    app, server, ctx,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(cfg.server.port, cfg.server.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : cfg.server.port;
      await registry.start(ctx);
      log.info("server_listen", {
        host: cfg.server.host, port, modules: registry.names(),
        auth: cfg.auth.enabled, tokens: tokens.size(),
        concurrency: cfg.concurrency.global, queueMaxSize: cfg.concurrency.queueMaxSize,
      });
      return { host: cfg.server.host, port };
    },
    async close() {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("shutdown_start");
      server.close();
      const timeout = new Promise<void>((resolve) =>
        setTimeout(() => { log.warn("shutdown_timeout_force"); resolve(); }, cfg.server.shutdownTimeoutMs).unref()
      );
      await Promise.race([gate.onIdle(), timeout]);
      await registry.stop(ctx);
      server.closeAllConnections?.();
      log.info("shutdown_done");
    },
  };
}
