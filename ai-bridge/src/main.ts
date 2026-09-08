#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { AppConfigSchema, SCOPES, type Scope } from "./config/schema.js";
import { createBridge } from "./app.js";
import { log } from "./core/logger.js";
import { defaultConfigPath, runtimeDir } from "./core/paths.js";
import { addFileToken, readTokenFile, resolveTokenFile, revokeFileToken } from "./auth/token-store.js";
import { createPoolRunner } from "./modules/pool/runner.js";
import { probe as probeCapabilities } from "./modules/pool/probe.js";
import { HubClient } from "./modules/pool/client.js";
import { fingerprint, readNodeIdentity, resolveNodeTokenFile, writeNodeIdentity } from "./modules/pool/token.js";
import { runSetup } from "./modules/pool/setup/server.js";

// 命令行入口。子命令：
//   start            按配置启动：mode=relay 起本机桥接，mode=pool 加入共享算力池
//   init             生成默认配置 + 第一个 admin token
//   status           探测本机桥接 /readyz
//   token add|list|revoke   维护 tokenFile
//   config path      打印配置文件路径
//   pool setup|pair|probe|status   共享算力池：配置向导、配对、探测本机能力、看本地状态
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : undefined;
}
function has(name: string, argv: string[]): boolean {
  return argv.includes(name);
}

function usage(): never {
  process.stdout.write(`ai-bridge <command> [options]

  start   [--config <path>]                         启动（relay 模式监听本机；pool 模式加入共享算力池）
  pool setup [--config <path>] [--hub <url>] [--port N] [--console <url>] [--no-open]
                                                    在浏览器里配对并勾选要共享的能力（推荐）
  pool pair <code> [--name <显示名>]                 用配对码换取长期节点令牌（只换令牌，不配贡献）
  pool probe                                        列出本机探测到的能力（只列出，不申报）
  pool status                                       打印本地节点状态与已配置的贡献
  init    [--config <path>] [--force]               生成配置文件与第一个 admin token
  status  [--url http://127.0.0.1:8787]             探测桥接状态
  token add --alias <name> [--scopes a,b] [--concurrency N]
  token list
  token revoke --alias <name>
  config path

  scopes: ${SCOPES.join(", ")}
  env:    AI_BRIDGE_CONFIG / AI_BRIDGE_CONFIG_DIR / AI_BRIDGE_RUNTIME_DIR / LOG_LEVEL
`);
  process.exit(2);
}

async function cmdStart(argv: string[]) {
  const cfg = loadConfig(arg("--config", argv));
  if (cfg.mode === "pool") return startPool(cfg);

  const bridge = await createBridge({ cfg });
  await bridge.listen();

  const pidFile = join(runtimeDir(), "ai-bridge.pid");
  await mkdir(dirname(pidFile), { recursive: true, mode: 0o700 });
  await writeFile(pidFile, String(process.pid) + "\n");

  const shutdown = async (sig: string) => {
    log.info("signal", { signal: sig });
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => log.error("unhandled_rejection", { reason: String(reason) }));
  process.on("uncaughtException", (err) => log.error("uncaught_exception", { message: err.message, stack: err.stack }));
}

// pool 模式不监听任何端口：进程只有出站连接，攻击面就是「主动连了谁」（P-15）。
async function startPool(cfg: Awaited<ReturnType<typeof loadConfig>>) {
  const runner = await createPoolRunner(cfg);
  await runner.start();

  const pidFile = join(runtimeDir(), "ai-bridge.pid");
  await mkdir(dirname(pidFile), { recursive: true, mode: 0o700 });
  await writeFile(pidFile, String(process.pid) + "\n");

  const shutdown = async (sig: string) => {
    log.info("signal", { signal: sig });
    await runner.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => log.error("unhandled_rejection", { reason: String(reason) }));
  process.on("uncaughtException", (err) => log.error("uncaught_exception", { message: err.message, stack: err.stack }));
}

async function cmdPool(argv: string[]) {
  const sub = argv[0];

  // setup 要在「还没有任何贡献」的状态下跑，而下面那句 loadConfig 在 mode=pool
  // 且贡献为空时会直接抛 —— 那正是 setup 来解决的事，所以它必须走在前面。
  if (sub === "setup") {
    const port = arg("--port", argv);
    await runSetup({
      configPath: arg("--config", argv),
      hubURL: arg("--hub", argv),
      port: port ? Number(port) : undefined,
      // 控制台不和 Hub 同源时用它指过去；给了就打印控制台入口并放进 CORS 白名单。
      consoleURL: arg("--console", argv),
      open: !argv.includes("--no-open"),
    });
    return;
  }

  const cfg = loadConfig(arg("--config", argv));

  if (sub === "pair") {
    const code = argv[1];
    if (!code || code.startsWith("--")) usage();
    if (!cfg.pool) throw new Error("配置里没有 pool 段：先把 mode 改成 pool 并配好 pool.hubURL");
    const client = new HubClient(cfg.pool.hubURL, cfg.pool.contract);
    const pkg = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8")) as { version?: string };
    const displayName = arg("--name", argv) ?? hostname();
    const result = await client.pair(code, displayName, pkg.version ?? "0.0.0");
    const file = resolveNodeTokenFile(cfg.pool);
    await writeNodeIdentity(file, {
      version: 1, nodeId: result.nodeId, token: result.token,
      hubURL: cfg.pool.hubURL, pairedAt: new Date().toISOString(),
    });
    process.stdout.write(`已加入共享池：nodeId=${result.nodeId} 令牌指纹=${fingerprint(result.token)}\n`);
    process.stdout.write(`令牌已写入 ${file}（权限 0600，明文只在本机）。\n`);
    // 配对只是绑定身份，还没决定共享什么。这里不能说「接下来 start 即可接单」——
    // contributions 为空时 start 会直接抛「没有任何启用的贡献」。
    if ((cfg.pool?.contributions ?? []).filter((c) => c.enabled).length === 0) {
      process.stdout.write("还没有勾选任何要共享的能力：跑 ai-bridge pool setup 在浏览器里选，或手工写 pool.contributions。\n");
    } else {
      process.stdout.write("接下来 ai-bridge start 即可开始接单。\n");
    }
    return;
  }

  if (sub === "probe") {
    const result = await probeCapabilities(cfg);
    process.stdout.write(`本机资源：${result.resources.os} cpu=${result.resources.cpu} mem=${result.resources.memGB}GB\n`);
    if (result.capabilities.length === 0) {
      process.stdout.write("没有探测到可贡献的能力（先在 providers 里配好 relay + authMode）\n");
      return;
    }
    for (const capability of result.capabilities) {
      const mark = capability.available ? "可用" : "不可用";
      process.stdout.write(`${capability.kind}\t${capability.provider}\t${mark}\t${capability.detail ?? ""}\n`);
    }
    process.stdout.write("\n探测到不等于已贡献：要共享哪几种、共享多少，跑 ai-bridge pool setup 在浏览器里勾，或手工写 pool.contributions。\n");
    return;
  }

  if (sub === "status") {
    const identity = await readNodeIdentity(resolveNodeTokenFile(cfg.pool));
    if (!identity) {
      process.stdout.write("尚未配对。在控制台生成配对码，然后运行 ai-bridge pool setup 在浏览器里配对并勾选要共享的能力。\n");
      process.exit(1);
    }
    process.stdout.write(`nodeId=${identity.nodeId} hub=${identity.hubURL} 配对于 ${identity.pairedAt}\n`);
    for (const contribution of cfg.pool?.contributions ?? []) {
      const quota = contribution.quota.map((q) => `${q.unit}=${q.limit}/${q.window}`).join(" ");
      process.stdout.write(
        `${contribution.enabled ? "启用" : "停用"}\t${contribution.id}\t${contribution.kind}\t` +
        `seats=${contribution.seats}x${contribution.seatConcurrency}\t${quota}\n`
      );
    }
    process.stdout.write("\n额度以 Hub 为权威，这里显示的是本地配置副本。\n");
    return;
  }
  usage();
}

async function cmdInit(argv: string[]) {
  const target = arg("--config", argv) ?? defaultConfigPath();
  if (existsSync(target) && !has("--force", argv)) {
    process.stdout.write(`配置已存在：${target}（加 --force 覆盖）\n`);
  } else {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(pkgRoot, "config.example.yaml"), target);
    process.stdout.write(`已生成配置：${target}\n`);
  }
  // 用刚生成的配置算 tokenFile 位置，再补一个 admin token
  const cfg = loadConfig(target);
  const tokenFile = resolveTokenFile(cfg.auth);
  const existing = await readTokenFile(tokenFile);
  if (existing.tokens.some((t) => t.alias === "admin")) {
    process.stdout.write(`admin token 已存在于 ${tokenFile}，未重复生成\n`);
    return;
  }
  const { token } = await addFileToken(tokenFile, { alias: "admin", scopes: ["*"] });
  process.stdout.write(`已生成 admin token（只显示这一次，请保存）：\n  ${token}\n  token 文件：${tokenFile}\n`);
}

async function cmdStatus(argv: string[]) {
  const url = (arg("--url", argv) ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  try {
    const r = await fetch(url + "/readyz", { signal: AbortSignal.timeout(3000) });
    const body = await r.text();
    process.stdout.write(`${r.status} ${body}\n`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    process.stdout.write(`桥接未响应：${url}（${(e as Error)?.message}）\n`);
    process.exit(1);
  }
}

async function cmdToken(argv: string[]) {
  const sub = argv[0];
  const cfgPath = arg("--config", argv);
  // token 命令不要求配置文件存在：没配置就用默认路径
  const cfg = cfgPath || existsSync(defaultConfigPath()) ? loadConfig(cfgPath) : AppConfigSchema.parse({});
  const tokenFile = resolveTokenFile(cfg.auth);

  if (sub === "add") {
    const alias = arg("--alias", argv);
    if (!alias) usage();
    const scopesRaw = arg("--scopes", argv);
    const scopes = (scopesRaw ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean) : ["relay:anthropic", "relay:openai"]) as Scope[];
    for (const s of scopes) if (!SCOPES.includes(s)) throw new Error(`未知 scope: ${s}（可选：${SCOPES.join(", ")}）`);
    const concurrencyRaw = arg("--concurrency", argv);
    const concurrency = concurrencyRaw ? Number(concurrencyRaw) : undefined;
    const { token } = await addFileToken(tokenFile, { alias, scopes, concurrency });
    process.stdout.write(`alias=${alias} scopes=${scopes.join(",")}\n${token}\n`);
    process.stdout.write(`（明文只显示这一次；已写入 ${tokenFile}。运行中的桥接会在下次 /admin/tokens/reload 或重启后生效）\n`);
    return;
  }
  if (sub === "list") {
    const file = await readTokenFile(tokenFile);
    const rows = [
      ...cfg.auth.tokens.map((t) => ({ alias: t.alias, scopes: t.scopes.join(","), source: "config", disabled: t.disabled })),
      ...file.tokens.map((t) => ({ alias: t.alias, scopes: t.scopes.join(","), source: "file", disabled: t.disabled })),
    ];
    if (rows.length === 0) process.stdout.write(`（没有任何 token；tokenFile=${tokenFile}）\n`);
    for (const r of rows) process.stdout.write(`${r.alias}\t${r.scopes}\t${r.source}${r.disabled ? "\tdisabled" : ""}\n`);
    return;
  }
  if (sub === "revoke") {
    const alias = arg("--alias", argv);
    if (!alias) usage();
    const ok = await revokeFileToken(tokenFile, alias);
    process.stdout.write(ok ? `已撤销 ${alias}\n` : `${alias} 不在 token 文件里（config 内联的请改配置文件）\n`);
    process.exit(ok ? 0 : 1);
  }
  usage();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "start": return cmdStart(rest);
    case "init": return cmdInit(rest);
    case "status": return cmdStatus(rest);
    case "token": return cmdToken(rest);
    case "pool": return cmdPool(rest);
    case "config":
      if (rest[0] === "path") { process.stdout.write(defaultConfigPath() + "\n"); return; }
      return usage();
    case "version": {
      const pkg = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
      process.stdout.write(`${pkg.name} ${pkg.version}\n`);
      return;
    }
    default: return usage();
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error)?.message ?? e}\n`);
  process.exit(1);
});
