import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import yaml from "js-yaml";
import { log } from "../../../core/logger.js";
import { defaultConfigPath } from "../../../core/paths.js";
import { loadConfig } from "../../../config/index.js";
import type { AppConfig } from "../../../config/schema.js";
import { probe } from "../probe.js";
import { HubClient } from "../client.js";
import { fingerprint, readNodeIdentity, resolveNodeTokenFile, writeNodeIdentity } from "../token.js";
import { setupPage } from "./page.js";

// pool setup 的本机配置服务。
//
// 为什么界面由这里吐、而不是让 galaxy 控制台跨源来调本机接口：
// 控制台生产环境是 HTTPS，HTTPS 页面访问 http://127.0.0.1 要同时过混合内容、
// CORS、以及 Chrome 的 Private Network Access 预检，三个浏览器的策略还不一致。
// 页面与接口同源就一个问题都没有。
//
// 为什么只在配置期起、配完就退：pool 模式运行时刻意不监听任何端口（P-15），
// 「攻击面就是主动连了谁」这条不该为了一次性的配置向导而永久让步。

const IDLE_SHUTDOWN_MS = 15 * 60 * 1000;

/**
 * 每种能力「少量」档一天给多少。
 *
 * 单位必须落在那个 kind 声明的允许集合里（relay / videofarm 适配器各自声明的
 * Metering.Units），用了集合外的单位，hello 会把整条贡献拒掉。
 *
 * 档位不是三张独立的表，而是同一张表乘一个倍数：三档之间只该差在「给多少」，
 * 分开写迟早写出「适中档给的 output 比全力档还多」这种事。
 */
const BASE_QUOTA: Record<string, Array<{ unit: string; limit: number }>> = {
  "llm.chat": [
    { unit: "llm.input_tokens", limit: 5_000_000 },
    { unit: "llm.output_tokens", limit: 1_000_000 },
  ],
  "video.edit.render": [
    { unit: "video.output_seconds", limit: 1_800 },
    { unit: "cpu.seconds", limit: 18_000 },
  ],
};

const TIERS = [
  { id: "light", name: "少量", scale: 1 },
  { id: "medium", name: "适中", scale: 4 },
  { id: "full", name: "全力", scale: 20 },
];

// SUPPORTED 是向导认的能力。
//
// delivery.task 不在里面：它必须由主人自己写 exec 命令（配置校验里那条
// 「agent 回合必须用 exec 指定执行器」），而且 delivery-task-planner 侧的
// --stdio 入口还没做。放进向导等于让人一键配出一条永远跑不通的贡献 ——
// 那比不提供更糟：派过去的活会失败，失败要算到这台机器的信誉上。
const SUPPORTED = new Set(Object.keys(BASE_QUOTA));

function quotaFor(kind: string, tierId: string) {
  const tier = TIERS.find((t) => t.id === tierId);
  if (!tier) throw new Error(`没有这个额度档位：${tierId}`);
  const base = BASE_QUOTA[kind];
  if (!base) throw new Error(`向导还不支持这种能力：${kind}`);
  return base.map((entry) => ({ unit: entry.unit, limit: entry.limit * tier.scale, window: "day" as const }));
}

export interface SetupOptions {
  configPath?: string;
  hubURL?: string;
  port?: number;
  open?: boolean;
}

interface SavedContribution {
  kind: string;
  upstream?: string;
  provider?: string;
  seats?: number;
  window?: string;
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const configPath = options.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`还没有配置文件：${configPath}（先运行 ai-bridge init）`);
  }
  // allowNoContributions：这条命令的目的就是把第一条贡献配出来，
  // 不放行的话第一次跑会被自己要修的那条错误挡在门外。
  let cfg = loadConfig(configPath, process.env, { allowNoContributions: true });

  const token = randomBytes(32).toString("hex");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  // 三道闸，缺一条这就是个「本机任何进程都能改你贡献配置」的接口：
  //   1. 只允许回环地址 —— 服务本来就只 bind 127.0.0.1，这是第二层。
  //   2. Host 头必须是 localhost/127.0.0.1 —— 挡 DNS 重绑定：恶意网站把自己的
  //      域名解析到 127.0.0.1，浏览器就会带着那个 Host 打进来。
  //   3. 一次性令牌 —— 页面是同源的，别的站点读不到它；没有它的请求一律拒。
  // 全程不发任何 CORS 头，跨源脚本读不到响应。
  const guard = (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ error: "只允许本机访问" });
      return;
    }
    if (!isLocalHost(req.headers.host)) {
      res.status(403).json({ error: "Host 头不是本机地址" });
      return;
    }
    if (!tokenMatches(token, req.header("x-setup-token"))) {
      res.status(401).json({ error: "令牌不对。请从命令打开的那个地址进入，不要手工敲网址。" });
      return;
    }
    next();
  };

  let closing = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const server = app.listen(options.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/?t=${token}`;

  const finish = () => {
    if (closing) return;
    closing = true;
    if (idleTimer) clearTimeout(idleTimer);
    // 先把响应发完再关：立刻 close 会让浏览器看到一个连接被掐断的错误。
    setTimeout(() => server.close(), 200);
  };
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log.warn("pool_setup_idle_timeout", { minutes: IDLE_SHUTDOWN_MS / 60000 });
      finish();
    }, IDLE_SHUTDOWN_MS);
  };
  touch();

  app.get("/", (req, res) => {
    // 页面本身不校验令牌 —— 它不吐任何数据，令牌是它要交给脚本的东西。
    // 真正的闸在 /api/*。
    if (!isLoopback(req.socket.remoteAddress) || !isLocalHost(req.headers.host)) {
      res.status(403).send("只允许本机访问");
      return;
    }
    touch();
    res.type("html").send(setupPage(token));
  });

  app.get("/api/state", guard, async (_req, res, next) => {
    touch();
    try {
      const result = await probe(cfg);
      res.json({
        configPath,
        hubURL: options.hubURL ?? cfg.pool?.hubURL ?? "",
        displayName: hostname(),
        resources: result.resources,
        capabilities: result.capabilities.map((capability) => ({
          ...capability,
          // 向导支持不支持这种能力，由服务端说了算，别让页面自己去猜 kind 列表。
          supported: SUPPORTED.has(capability.kind),
        })),
        tiers: TIERS.map((tier) => ({
          id: tier.id,
          name: tier.name,
          quota: Object.fromEntries(Object.keys(BASE_QUOTA).map((kind) => [kind, quotaFor(kind, tier.id)])),
        })),
        contributions: describeContributions(cfg),
        ...(await pairedState(cfg)),
      });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/join", guard, async (req, res, next) => {
    touch();
    try {
      const hubURL = requireString(req.body?.hubURL, "平台地址");
      const code = requireString(req.body?.code, "配对码");
      const displayName = String(req.body?.displayName ?? "").trim() || hostname();
      const contractVersion = cfg.pool?.contract ?? 1;
      const client = new HubClient(hubURL, contractVersion);
      const paired = await client.pair(code, displayName, await bridgeVersion());
      const file = resolveNodeTokenFile(cfg.pool);
      await writeNodeIdentity(file, {
        version: 1, nodeId: paired.nodeId, token: paired.token,
        hubURL, pairedAt: new Date().toISOString(),
      });
      log.info("pool_setup_paired", { nodeId: paired.nodeId, fingerprint: fingerprint(paired.token) });
      res.json({ nodeId: paired.nodeId, tokenFile: file });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/save", guard, async (req, res, next) => {
    touch();
    try {
      const hubURL = requireString(req.body?.hubURL, "平台地址");
      const picks: Pick[] = Array.isArray(req.body?.picks) ? req.body.picks : [];
      if (picks.length === 0) throw new Error("至少要勾一项能力");
      const tier = requireString(req.body?.tier, "额度档位");
      const seats = requirePositive(req.body?.seats, "同时服务人数");
      const window = String(req.body?.window ?? "").trim();
      if (window && !/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(window)) {
        throw new Error("挂机时段要写成 23:00-08:00 这种形状");
      }
      // 勾选是从浏览器来的，一个字段都不能当真：kind 决定用哪套额度单位，
      // upstream 会变成「借哪一份凭据」，两个都必须回到本机配置里核一遍。
      for (const pick of picks) {
        if (!SUPPORTED.has(pick.kind)) throw new Error(`向导还不支持这种能力：${pick.kind}`);
        if (pick.kind === "llm.chat") {
          const name = requireString(pick.upstream, "凭据来源");
          const provider = cfg.providers[name];
          if (!provider) throw new Error(`配置里没有 provider "${name}"`);
          if (provider.type !== "relay" || !provider.baseURL || !provider.authMode) {
            throw new Error(`provider "${name}" 不是配了 baseURL 与 authMode 的 relay，不能作为中转类贡献`);
          }
        } else {
          requireString(pick.provider, "执行器");
        }
        quotaFor(pick.kind, tier);
      }

      const written = await writeContributions(configPath, { hubURL, picks, tier, seats, window });
      // 写完立刻按**严格**规则重读一次：宁可在这里报错，也不要让用户
      // 兴冲冲去跑 start 才发现配置是坏的。
      cfg = loadConfig(configPath, process.env);
      res.json({ configPath, count: picks.length, backup: written.backup });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/finish", guard, (_req, res) => {
    res.json({ ok: true });
    finish();
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: error?.message ?? "未知错误" });
  });

  process.stdout.write(`配置向导已启动：${url}\n`);
  process.stdout.write("它只监听本机、只接受这一个地址里的令牌，配置完成或 15 分钟无操作后自动退出。\n");
  if (options.open !== false) openBrowser(url);

  await once(server, "close");
  process.stdout.write("配置向导已退出。\n");
}

// ---------- 配置写回 ----------

/** 一条被勾中的能力。llm.chat 靠 upstream 借订阅登录态，本机执行类靠 provider 路由。 */
interface Pick {
  kind: string;
  upstream?: string;
  provider?: string;
}

interface WriteInput {
  hubURL: string;
  picks: Pick[];
  tier: string;
  seats: number;
  window: string;
}

/**
 * 把勾选结果写回 config.yaml。
 *
 * **只动 `mode:` 那一行和 `pool:` 那一段，其余每一行原样保留。**
 *
 * 不走「整个 load 再 dump」那条路：`init` 生成的配置里三分之二是注释，
 * 把每个字段的用途、风险和默认值都写在旁边，round-trip 一次全没了
 * （实测 7032 字节缩到 1249）。用户第一次配置就把说明书弄丢，不是可接受的代价。
 *
 * 换 YAML 库能保住注释，但为一次写回引一条依赖不划算；顶层块的边界在 YAML 里
 * 就是「行首非空白」，切起来足够确定。切完立刻按严格规则重读一次做验证。
 */
async function writeContributions(configPath: string, input: WriteInput): Promise<{ backup: string }> {
  const original = await readFile(configPath, "utf8");

  const contributions = input.picks.map((pick) => ({
    // id 用 upstream 的配置键或 provider 路由键：两者在各自的命名空间里都唯一，
    // 而且一眼看得出这条贡献是哪来的。
    id: pick.upstream ?? pick.provider ?? pick.kind,
    kind: pick.kind,
    ...(pick.upstream ? { upstream: pick.upstream } : { provider: pick.provider }),
    seats: input.seats,
    quota: quotaFor(pick.kind, input.tier),
    ...(input.window ? { schedule: [{ window: input.window }] } : {}),
    enabled: true,
  }));
  // 保留 pool 段里除 hubURL / contributions 之外的字段（heartbeatSec、tokenFile 这些）。
  const previous = (yaml.load(original) ?? {}) as Record<string, any>;
  const pool = { ...(previous.pool ?? {}), hubURL: input.hubURL, contributions };

  let text = replaceTopLevel(original, "mode", "mode: pool\n");
  text = replaceTopLevel(text, "pool", yaml.dump({ pool }, { lineWidth: 100, noRefs: true }));

  const backup = `${configPath}.bak`;
  await writeFile(backup, original, { mode: 0o600 });
  const tmp = `${configPath}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, configPath);
  return { backup };
}

/**
 * 把顶层的 `<key>:` 整块换成 replacement；原来没有就追加到末尾。
 *
 * 一个顶层块从 `^<key>:` 开始，到下一个**行首非空白**的行为止 —— 中间的缩进行
 * 和空行都属于它。紧贴在块前面的注释属于这个块，一并替换掉，
 * 否则会留下一段描述已经不存在的字段的说明。
 */
export function replaceTopLevel(text: string, key: string, replacement: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start < 0) {
    const separator = text.endsWith("\n") ? "" : "\n";
    return `${text}${separator}\n${replacement}`;
  }
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || /^[ \t]/.test(lines[end]))) end += 1;
  // 块尾往回收：末尾的空行留给下一段，不然每写一次就多吞一个空行。
  while (end > start + 1 && lines[end - 1] === "") end -= 1;
  // 块头往前收：紧贴着的注释是这一段的说明。
  let head = start;
  while (head > 0 && lines[head - 1].trimStart().startsWith("#")) head -= 1;

  const body = replacement.endsWith("\n") ? replacement.slice(0, -1) : replacement;
  return [...lines.slice(0, head), ...body.split("\n"), ...lines.slice(end)].join("\n");
}

function describeContributions(cfg: AppConfig): SavedContribution[] {
  return (cfg.pool?.contributions ?? []).map((c) => ({
    kind: c.kind,
    upstream: c.upstream,
    provider: c.provider,
    seats: c.seats,
    window: c.schedule[0]?.window,
  }));
}

async function pairedState(cfg: AppConfig): Promise<{ paired: boolean; nodeId?: string }> {
  const identity = await readNodeIdentity(resolveNodeTokenFile(cfg.pool));
  return identity ? { paired: true, nodeId: identity.nodeId } : { paired: false };
}

// ---------- 小工具 ----------

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.replace(/^::ffff:/, "");
  return value === "127.0.0.1" || value === "::1" || value.startsWith("127.");
}

// isLocalHost 挡 DNS 重绑定：恶意站点把自己的域名解析到 127.0.0.1 之后，
// 浏览器发过来的请求源地址确实是回环，但 Host 头是那个域名。
function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

// tokenMatches 等长比较必须是常数时间的，否则比较耗时会把令牌一个字节一个字节地泄露。
function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}

function requireString(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function requirePositive(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || !Number.isInteger(number)) {
    throw new Error(`${label}要是一个正整数`);
  }
  return number;
}

function once(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

async function bridgeVersion(): Promise<string> {
  try {
    const { readFile: read } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await read(join(here, "..", "..", "..", "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// openBrowser 打不开就算了：地址已经打印在终端里，用户自己粘一下也能进。
function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* 忽略：终端里有地址 */
  }
}
