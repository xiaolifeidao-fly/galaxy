import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import { hostname } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { log } from "../../../core/logger.js";
import { defaultConfigPath } from "../../../core/paths.js";
import { loadConfig } from "../../../config/index.js";
import type { AppConfig } from "../../../config/schema.js";
import { probe } from "../probe.js";
import { HubClient } from "../client.js";
import { fingerprint, readNodeIdentity, resolveNodeTokenFile, writeNodeIdentity } from "../token.js";

// pool setup：本机的**配对**向导。
//
// 它只干一件事 —— 拿配对码换长期节点令牌，把这台机器绑到主人的账号上。
//
// 「共享哪几种能力、共享多少、什么时段」**不在这里**：那些是主人在 Galaxy 控制台的
// 「贡献授权」里定的，Hub 每次心跳下发给节点。理由是主人要能随时随地调整，
// 而不是每次都得回到这台机器上跑一遍命令。本机只保留两件 Hub 做不了的事：
// 换令牌（要写本机文件），和探测本机有什么能力（要读本机的订阅登录态）。
//
// 这里**没有界面**，只有接口。界面全在 Galaxy 控制台（client/galaxy）里，
// 跨源直连这些接口。插件不再自带一份 HTML —— 两处各维护一套同样的表单和文案，
// 迟早会漂移，而漂移的那一半没人会发现。
//
// 跨源全开（Access-Control-Allow-Origin: *）。因此**令牌是唯一的闸**：
// Host 头校验挡的是 DNS 重绑定，回环绑定挡的是别的机器，两者都挡不住
// 「用户访问了恶意站点、而那个站点知道令牌」。令牌是 32 字节随机数、只活
// 15 分钟、随进程消失，但它会出现在终端输出和地址栏里 —— 别把它贴出去。
//
// 跨源还要过 Chrome 的 Private Network Access 预检，所以下面显式回了
// Allow-Private-Network。控制台生产环境是 HTTPS 而这里是 http://127.0.0.1，
// Chrome / Firefox 把回环当可信源放行，Safari 更严 —— 那条治不了。
//
// 为什么只在配对期起、配完就退：pool 模式运行时刻意不监听任何端口（P-15），
// 「攻击面就是主动连了谁」这条不该为了一次性的配对向导而永久让步。

const IDLE_SHUTDOWN_MS = 15 * 60 * 1000;

// 配置向导的固定端口。随机端口对本机页面无所谓（地址是它自己打印的），但控制台要
// 跨源过来调就必须**事先**知道打哪儿，只能靠一个约定端口。被占用时直接报错退出，
// 不悄悄换一个 —— 换了控制台就连到一个不存在的地方，还查不出原因。
const DEFAULT_SETUP_PORT = 39217;

// 配对成功后的收尾窗口。配完就没有任何理由再敞着 15 分钟 —— 那段时间里
// 令牌一旦泄漏（截图、地址栏、日志），别人就能拿它改这台机器的配置。
// 留 30 秒是给控制台刷一次能力清单、让主人看一眼，不是给人操作用的。
const POST_PAIR_GRACE_MS = 30_000;

export interface SetupOptions {
  configPath?: string;
  hubURL?: string;
  port?: number;
  open?: boolean;
  /** Galaxy 控制台地址。给了才会打印控制台入口，并把它的源加进 CORS 白名单。 */
  consoleURL?: string;
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const configPath = options.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`还没有配置文件：${configPath}（先运行 ai-bridge init）`);
  }
  const cfg = loadConfig(configPath, process.env);

  const token = randomBytes(32).toString("hex");

  // 允许配对到哪个 Hub，**在启动时就定死**，不接受请求体里现编的地址。
  //
  // 挡的是这条：令牌一旦泄漏（截图、地址栏、服务器日志），拿到它的人可以调
  // /api/join 传自己的 hubURL —— 他自己的 Hub 当然认任何配对码 —— 于是这台机器的
  // node-token 和 config 被改写，下次启动就去给他干活，用的是主人的订阅额度。
  // 装了 LaunchAgent 之后那个「下次启动」还是开机自动发生的。
  //
  // 首次配对的机器没有可锁的值（init 的模板里没有 pool 段），那时锁不了也不该锁死：
  // 还没配上任何东西的机器没有可偷的。所以有就锁，没有就在启动时说清楚。
  const pinnedHub = originOf(options.hubURL ?? cfg.pool?.hubURL);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  // 跨源对所有来源开放。控制台可能被部署在任何域名下，枚举不完；鉴权交给令牌。
  //
  // 令牌怎么到控制台手上：pool setup 打印的控制台地址里带着它
  // （?bridge=<端口>&t=<令牌>），控制台页面从自己的 query 里取出来，放进
  // x-setup-token 发过来。令牌不经过 Hub，只在这台机器的浏览器里。
  app.use((req: Request, res: Response, next: NextFunction) => {
    // 通配符和 Allow-Credentials 互斥，但这里本来就不用 cookie，鉴权走头。
    // 也因此不需要 Vary: Origin —— 响应不随来源变化。
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-setup-token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");

    // Chrome 的 Private Network Access：公网页面打私有网段要多一次预检，
    // 少这一条预检就直接失败，业务请求根本发不出去。
    if (req.header("access-control-request-private-network") === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // 三道闸，缺一条这就是个「本机任何进程都能改你贡献配置」的接口：
  //   1. 只允许回环地址 —— 服务本来就只 bind 127.0.0.1，这是第二层。
  //   2. Host 头必须是 localhost/127.0.0.1 —— 挡 DNS 重绑定：恶意网站把自己的
  //      域名解析到 127.0.0.1，浏览器就会带着那个 Host 打进来。
  //      控制台跨源过来时 Host 仍是 127.0.0.1:<端口>（fetch 的目标就是它），
  //      所以这道闸对控制台是透明的，不用为了跨域把它拆掉。
  //   3. 一次性令牌 —— 跨源脚本拿不到它，除非用户自己从向导地址进来。
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
  let idleMs = IDLE_SHUTDOWN_MS;
  const wanted = options.port ?? DEFAULT_SETUP_PORT;
  const server = app.listen(wanted, "127.0.0.1");
  await listening(server, wanted);
  const port = (server.address() as AddressInfo).port;
  const endpoint = `http://127.0.0.1:${port}`;
  // 控制台地址的三个来源，由近及远：命令行 → 环境变量 → 配置里的 Hub 源
  // （控制台与 Hub 同源部署是最常见的形态，装完就能直接用）。
  const consoleURL = buildConsoleURL(
    options.consoleURL ?? process.env.AI_BRIDGE_CONSOLE_URL ?? options.hubURL ?? cfg.pool?.hubURL,
    port,
    token,
  );

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
      log.warn("pool_setup_idle_timeout", { seconds: Math.round(idleMs / 1000) });
      finish();
    }, idleMs);
  };
  touch();

  // 界面搬走之后这里不再吐 HTML。留一句话是因为老流程打印过带 /?t= 的地址，
  // 书签和终端历史里还有 —— 直接 404 会让人以为装坏了。
  app.get("/", (_req, res) => {
    res.type("text").send("ai-bridge 配置接口。界面在 Galaxy 控制台的「加入共享池」里。");
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
        // 能力清单在这里是**只读**的：给主人一个「这台机器上探得到什么」的确认，
        // 勾选与额度在控制台。写在这儿的话就又变成两个配置入口了。
        capabilities: result.capabilities,
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
      if (pinnedHub && originOf(hubURL) !== pinnedHub) {
        throw new Error(
          `这台机器只能配对到 ${pinnedHub}。要换一个 Hub，请在本机重跑：ai-bridge pool setup --hub <新地址>`,
        );
      }
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
      // 连接信息要落到配置里，否则 ai-bridge start 不知道连哪个 Hub。
      // 这是本机配置**唯一**还需要写的东西 —— 共享什么、共享多少都在控制台。
      const written = await writePoolConnection(configPath, hubURL);
      log.info("pool_setup_paired", { nodeId: paired.nodeId, fingerprint: fingerprint(paired.token) });
      // 配完就收尾。剩下的只有「让主人看一眼探到了什么」，30 秒够了。
      idleMs = POST_PAIR_GRACE_MS;
      touch();
      res.json({
        nodeId: paired.nodeId, tokenFile: file, configPath, backup: written.backup,
        closingInSec: Math.round(POST_PAIR_GRACE_MS / 1000),
      });
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

  process.stdout.write(`本机配置接口已就绪：${endpoint}\n`);
  if (consoleURL) {
    process.stdout.write(`在 Galaxy 控制台里完成配对：${consoleURL}\n`);
  } else {
    // 连 Hub 地址都没有（pool 段还没配过）。把参数原样给出来让用户自己拼 ——
    // 没有这两个值，控制台就找不到本机接口，向导等于白起。
    process.stdout.write("没有控制台地址（--console / AI_BRIDGE_CONSOLE_URL）。把下面这段接到你的控制台地址后面：\n");
    process.stdout.write(`  /provider/overview?bridge=${port}&t=${token}\n`);
  }
  process.stdout.write("接口只监听本机、只认这一个令牌，配置完成或 15 分钟无操作后自动退出。\n");
  if (!pinnedHub) {
    process.stdout.write("注意：这台机器还没配过 Hub，本次配对接受浏览器填入的任意平台地址。\n");
    process.stdout.write("      配过一次之后就会锁死，之后要换 Hub 得带 --hub 重跑。\n");
  }
  if (options.open !== false && consoleURL) openBrowser(consoleURL);

  await once(server, "close");
  process.stdout.write("配置接口已退出。\n");
}

// ---------- 配置写回 ----------

/** 一条被勾中的能力。llm.chat 靠 upstream 借订阅登录态，本机执行类靠 provider 路由。 */
interface Pick {
  kind: string;
  upstream?: string;
  provider?: string;
}

/**
 * 把配对拿到的连接信息写回 config.yaml：`mode: pool` 和 `pool.hubURL`。
 *
 * **只动这两处，其余每一行原样保留。** 不走「整个 load 再 dump」那条路：
 * init 生成的配置里三分之二是注释，把每个字段的用途、风险和默认值都写在旁边，
 * round-trip 一次全没了（实测 7032 字节缩到 1249）。用户第一次配置就把说明书
 * 弄丢，不是可接受的代价。
 *
 * 顶层块的边界在 YAML 里就是「行首非空白」，切起来足够确定。
 */
async function writePoolConnection(configPath: string, hubURL: string): Promise<{ backup: string }> {
  const original = await readFile(configPath, "utf8");
  const previous = (yaml.load(original) ?? {}) as Record<string, any>;
  // 保留 pool 段里的其它字段（heartbeatSec、tokenFile、contract 这些）。
  const pool = { ...(previous.pool ?? {}), hubURL };

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

async function pairedState(cfg: AppConfig): Promise<{ paired: boolean; nodeId?: string }> {
  const identity = await readNodeIdentity(resolveNodeTokenFile(cfg.pool));
  return identity ? { paired: true, nodeId: identity.nodeId } : { paired: false };
}

// ---------- 小工具 ----------

/**
 * 控制台入口地址：把端口和一次性令牌带过去，控制台页面靠它们直连本机。
 *
 * 放 **fragment** 而不是 query：fragment 永远不会发给服务器。用 `?t=` 的话，
 * 每次打开这个页面令牌都会进控制台服务器的访问日志（开发时是 Next dev server，
 * 生产还要加上反代和 CDN）—— 那是几个泄漏渠道里唯一一个主人完全察觉不到的。
 * 它也不会出现在 Referer 里。
 *
 * 读取端是纯客户端的（readBridgeConn 有 window 守卫、在 effect 里调），
 * 服务端渲染不需要这两个值，所以 fragment 够用。
 */
export function buildConsoleURL(base: string | undefined, port: number, token: string): string | undefined {
  const text = base?.trim();
  if (!text) return undefined;
  try {
    const target = new URL("/provider/overview", text);
    // 用 URLSearchParams 生成 fragment 内容，转义交给它 —— 手拼的话令牌里
    // 万一出现 & 就会把参数截断（当前是十六进制不会，但别靠「不会」活着）。
    target.hash = new URLSearchParams({ bridge: String(port), t: token }).toString();
    return target.toString();
  } catch {
    return undefined;
  }
}

// listening：起不来必须说清楚是端口被占了。固定端口是为了让控制台找得到，
// 悄悄换一个只会让控制台连到一个不存在的地方，比直接失败更难查。
function listening(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`端口 ${port} 被占用了。换一个：ai-bridge pool setup --port <端口>`)
          : error,
      );
    });
  });
}

// originOf 只取协议+主机+端口。Hub 地址可能带路径（自建部署挂在子路径下），
// 比对必须按源来，否则同一个 Hub 写法差一个尾斜杠就配不上。
export function originOf(value: string | undefined): string {
  try {
    return new URL(String(value ?? "")).origin;
  } catch {
    return "";
  }
}

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
