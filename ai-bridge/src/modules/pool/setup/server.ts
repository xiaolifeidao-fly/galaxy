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
import { CredentialRegistry, resolveUpstream } from "../../../credentials/index.js";
import { toolStatuses, upgradeTool } from "../tools.js";
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
// 这个接口有两种生命周期，见 startSetupServer 的说明：
//   · 临时（pool setup）—— 机器还没配对，常驻进程起不来，配完就退；
//   · 常驻（ai-bridge start）—— 已配对的机器一直挂着，这样主人随时能从控制台
//     重新配对，而不必在令牌失效时回终端跑命令。
//
// 常驻这一档是对 P-15「一个端口都不开」的**有意让步**：pool 模式除此之外仍然
// 只有出站连接。让步的代价由三条兜住 —— 只绑回环、配对码鉴权（Hub 只发给已登录
// 机主、一次性）、以及 Hub 地址在启动时锁死，配对不到别处去。

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
  /** Galaxy 控制台地址。给了才会打印控制台入口。 */
  consoleURL?: string;
  /** 常驻模式：挂在 ai-bridge start 里，无令牌、无空闲超时，鉴权靠配对码。 */
  resident?: boolean;
  /** 常驻模式下重新配对成功后的回调。用来让进程退出、由 supervisor 换新身份拉起。 */
  onPaired?: () => void;
}

/**
 * authMode → 拉起登录的命令。
 *
 * **只认这张表。** 请求体里只能传上游的名字，命令由本机配置里那个上游自己的
 * authMode 决定 —— 否则这就是个「让任意网站在你机器上跑任意命令」的接口。
 * api_key 不在表里：那种上游的凭据是写在配置里的，没有可拉起的登录流程。
 */
const LOGIN_COMMANDS: Record<string, string[]> = {
  claude_oauth: ["claude", "auth", "login"],
  codex_chatgpt: ["codex", "login"],
};

/** 常驻模式下 /api/join 的限流窗口：它没有令牌闸，只有配对码。 */
const PAIR_WINDOW_MS = 60_000;
const PAIR_MAX_PER_WINDOW = 10;

export interface SetupHandle {
  port: number;
  /** 只有临时模式才有。常驻模式不发令牌，鉴权靠配对码。 */
  token?: string;
  consoleURL?: string;
  pinnedHub: string;
  close: () => void;
  closed: Promise<void>;
}

/**
 * 起配置接口。两种形态共用同一套代码，区别只有鉴权和生命周期：
 *
 * - **临时**（`ai-bridge pool setup`）：机器还没配对过，常驻进程根本起不来
 *   （createPoolRunner 没有节点令牌会直接抛）。这一档**必须**有 URL 令牌闸 ——
 *   新机器没有锁定的 Hub，恶意站点若能调 /api/join 就能把这台机器配对到它自己的
 *   Hub，之后拿主人的订阅额度干活。而这一档的令牌就打印在刚跑完的那条命令下面，
 *   用户拿得到，代价很小。
 *
 * - **常驻**（`ai-bridge start` 的 pool 模式）：机器已经配对，Hub 已经锁死。
 *   这一档**不要**令牌 —— 要令牌就意味着每次改配置都得回终端跑一遍命令，
 *   而那正是要解决的问题。鉴权交给配对码：它由 Hub 只签发给已登录的机主、
 *   一次性、10 分钟有效，而且这里会拿它去**已锁定的那个 Hub** 真兑换一次，
 *   兑得动就证明调用方拥有这个账号。最坏情况（配对码泄漏）也只是在主人自己
 *   账号下多出一个节点，劫不走。
 */
export async function startSetupServer(options: SetupOptions = {}): Promise<SetupHandle> {
  const resident = options.resident === true;
  const configPath = options.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`还没有配置文件：${configPath}（先运行 ai-bridge init）`);
  }
  const cfg = loadConfig(configPath, process.env);
  // 解析上游凭据用；/api/upstream/login 靠它判断「是不是真的不可用」。
  const credentials = new CredentialRegistry();

  // 常驻模式不发令牌：那一档靠配对码鉴权，见上面的说明。
  const token = resident ? "" : randomBytes(32).toString("hex");

  // 允许配对到哪个 Hub，**在启动时就定死**，不接受请求体里现编的地址。
  //
  // 挡的是这条：调用方可以调 /api/join 传自己的 hubURL —— 他自己的 Hub 当然认
  // 任何配对码 —— 于是这台机器的 node-token 和 config 被改写，下次启动就去给他
  // 干活，用的是主人的订阅额度。装了 LaunchAgent 之后那个「下次启动」还是开机自动的。
  //
  // 首次配对的机器没有可锁的值（init 的模板里没有 pool 段），那时锁不了也不该锁死：
  // 还没配上任何东西的机器没有可偷的 —— 那一档改由令牌闸兜着。
  const pinnedHub = originOf(options.hubURL ?? cfg.pool?.hubURL);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  // 跨源对所有来源开放：控制台可能被部署在任何域名下，枚举不完。
  app.use((req: Request, res: Response, next: NextFunction) => {
    // 通配符和 Allow-Credentials 互斥，但这里本来就不用 cookie，鉴权走头/请求体。
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

  // 本机闸，两种形态都有：
  //   1. 只允许回环地址 —— 服务本来就只 bind 127.0.0.1，这是第二层。
  //   2. Host 头必须是 localhost/127.0.0.1 —— 挡 DNS 重绑定：恶意网站把自己的
  //      域名解析到 127.0.0.1，浏览器就会带着那个 Host 打进来。
  //      控制台跨源过来时 Host 仍是 127.0.0.1:<端口>（fetch 的目标就是它），
  //      所以这道闸对控制台是透明的。
  const localOnly = (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ error: "只允许本机访问" });
      return;
    }
    if (!isLocalHost(req.headers.host)) {
      res.status(403).json({ error: "Host 头不是本机地址" });
      return;
    }
    next();
  };

  // 临时模式的令牌闸。常驻模式没有令牌，这一层直接放行。
  const guard = (req: Request, res: Response, next: NextFunction) => {
    if (!resident && !tokenMatches(token, req.header("x-setup-token"))) {
      res.status(401).json({ error: "令牌不对。请从命令打开的那个地址进入，不要手工敲网址。" });
      return;
    }
    next();
  };

  // 配对码爆破没戏（40 位、一次性、10 分钟），但每次尝试都会让本机去打一次 Hub。
  // 不限流就等于把这台机器变成打 Hub 的放大器。
  let windowStart = 0;
  let windowCount = 0;
  const rateLimit = (_req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - windowStart > PAIR_WINDOW_MS) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    if (windowCount > PAIR_MAX_PER_WINDOW) {
      res.status(429).json({ error: "配对尝试过于频繁，稍后再试" });
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
  const consoleURL = resident
    ? undefined
    : buildConsoleURL(
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
  // 常驻模式没有空闲超时 —— 它就是要一直在，这才是「随时能从控制台配」的前提。
  const touch = () => {
    if (resident) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log.warn("pool_setup_idle_timeout", { seconds: Math.round(idleMs / 1000) });
      finish();
    }, idleMs);
  };
  touch();

  app.get("/", (_req, res) => {
    res.type("text").send("ai-bridge 配置接口。界面在 Galaxy 控制台的「加入共享池」里。");
  });

  // ping 不鉴权，也**只**回这两个布尔值。控制台靠它判断「本机有没有 ai-bridge 在跑、
  // 要不要显示配对表单」—— 没有这个探针，控制台就只能靠 URL 参数被动触发，
  // 也就回到了「只有装插件那一次能配」的老问题。
  // 代价是任何网站都能探出你装了 ai-bridge。这是为可用性付的、有界的代价：
  // 它不吐机器名、不吐能力清单、不吐配置路径，那些都在鉴权后面。
  app.get("/api/ping", localOnly, async (_req, res) => {
    res.json({ running: true, resident, ...(await pairedState(cfg)) });
  });

  // 能力清单和配置路径是机器指纹，只在临时模式（有令牌）下给。
  // 常驻模式不挂它：配对之后控制台从 Hub 拿 available / unavailableReason 就够了，
  // 再开一个本机口子只是白添攻击面。
  if (!resident) {
    app.get("/api/state", localOnly, guard, async (_req, res, next) => {
      touch();
      try {
        const result = await probe(cfg);
        res.json({
          configPath,
          hubURL: options.hubURL ?? cfg.pool?.hubURL ?? "",
          displayName: hostname(),
          resources: result.resources,
          capabilities: result.capabilities,
          ...(await pairedState(cfg)),
        });
      } catch (e) {
        next(e);
      }
    });

    app.post("/api/finish", localOnly, guard, (_req, res) => {
      res.json({ ok: true });
      finish();
    });
  }

  /**
   * 拉起某个上游的登录流程。
   *
   * 为什么要有这个：Claude 登录态过期时，控制台能看到「不可用 + 请运行 claude auth
   * login」，但主人得自己找到那台机器、开终端、敲命令。有了它，点一下就把终端开起来。
   *
   * 为什么开**终端窗口**而不是直接 spawn：`claude auth login` 是交互式的，要给用户看
   * 授权链接、可能还要粘贴回码。而 bridge 是 LaunchAgent，没有 TTY —— headless 起它
   * 只会挂在那儿。开一个真终端是唯一稳的做法，开不起来就把命令回给控制台让人自己敲。
   *
   * 鉴权：这个端点没有令牌闸（常驻接口本来就没有）。能接受是因为它对攻击者没有收益 ——
   * 授权完成后凭据进的是**主人自己的** keychain，攻击者拿不到任何东西，最多是骚扰。
   * 即便如此还是收窄了两处：限流，以及**只在凭据确实不可用时才允许拉起** ——
   * 已经登录好的时候拒掉，免得它变成一个随时可用的「开终端」原语。
   */
  /**
   * 本机几个工具的版本与可升级状态，给控制台的版本面板用。
   *
   * 不鉴权，和 /api/ping 一样 —— 控制台没有会话凭据可用。代价是任何本机页面
   * 都能读到你装了哪些工具、什么版本，这是个指纹。可用性收益大于这点泄漏，
   * 但值得知道：它比 ping 多吐了三个版本号。
   */
  app.get("/api/tools", localOnly, async (_req, res, next) => {
    try {
      res.json({ tools: await toolStatuses() });
    } catch (e) {
      next(e);
    }
  });

  /** 拉起一次升级。命令走固定表，请求体只能传工具名。 */
  app.post("/api/tools/upgrade", localOnly, rateLimit, async (req, res, next) => {
    try {
      const name = requireString(req.body?.tool, "工具名");
      res.json({ started: true, ...upgradeTool(name) });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/upstream/login", localOnly, rateLimit, async (req, res, next) => {
    try {
      const name = requireString(req.body?.provider, "上游名称");
      const provider = cfg.providers[name];
      if (!provider) throw new Error(`本机配置里没有这个上游：${name}`);
      const argv = provider.authMode ? LOGIN_COMMANDS[provider.authMode] : undefined;
      if (!argv) {
        throw new Error(
          `${name} 的登录方式是 ${provider.authMode ?? "未配置"}，没有可拉起的登录命令`,
        );
      }
      // 已经好了就不给拉：这一条把它从「通用开终端接口」收窄成「修不可用状态」。
      try {
        const credential = credentials.resolve(provider);
        await credential.headers({
          header: () => undefined,
          principal: { alias: "probe", scopes: new Set(["*"] as const), source: "anonymous" },
          requestId: "upstream-login",
          provider,
          providerName: name,
          upstream: await resolveUpstream(provider),
        });
        res.json({ command: argv.join(" "), launched: false, alreadyAuthorized: true });
        return;
      } catch {
        // 解析不了才继续 —— 这正是要修的状态。
      }
      const command = argv.join(" ");
      log.info("pool_upstream_login_launch", { provider: name, command });
      res.json({ command, launched: openTerminal(command) });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/join", localOnly, rateLimit, guard, async (req, res, next) => {
    touch();
    try {
      // 常驻模式下 Hub 一定是锁定的（能常驻就说明配对过），请求体里的地址只做校验。
      const hubURL = pinnedHub && resident ? pinnedHub : requireString(req.body?.hubURL, "平台地址");
      if (pinnedHub && originOf(hubURL) !== pinnedHub) {
        throw new Error(
          `这台机器只能配对到 ${pinnedHub}。要换一个 Hub，请在本机重跑：ai-bridge pool setup --hub <新地址>`,
        );
      }
      const code = requireString(req.body?.code, "配对码");
      const displayName = String(req.body?.displayName ?? "").trim() || hostname();
      const contractVersion = cfg.pool?.contract ?? 1;
      const client = new HubClient(hubURL, contractVersion);
      const file = resolveNodeTokenFile(cfg.pool);
      // 先读旧身份再配对：配对成功后这个文件就被覆盖了，那时再读已经晚了。
      const previous = await readNodeIdentity(file);
      const paired = await client.pair(code, displayName, await bridgeVersion(), previous?.nodeId);
      await writeNodeIdentity(file, {
        version: 1, nodeId: paired.nodeId, token: paired.token,
        hubURL, pairedAt: new Date().toISOString(),
      });
      const written = await writePoolConnection(configPath, hubURL);
      log.info("pool_setup_paired", { nodeId: paired.nodeId, fingerprint: fingerprint(paired.token), resident });
      if (!resident) {
        // 配完就收尾。剩下的只有「让主人看一眼探到了什么」，30 秒够了。
        idleMs = POST_PAIR_GRACE_MS;
        touch();
      }
      res.json({
        nodeId: paired.nodeId, tokenFile: file, configPath, backup: written.backup,
        ...(resident ? { restarting: true } : { closingInSec: Math.round(POST_PAIR_GRACE_MS / 1000) }),
      });
      // 常驻进程手里还攥着**旧**的节点身份，重新配对之后那份已经作废了。
      // 让它退出、由 supervisor 用新令牌拉起来，比在运行中热替换身份简单也可靠得多。
      if (resident) options.onPaired?.();
    } catch (e) {
      next(e);
    }
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: error?.message ?? "未知错误" });
  });

  return {
    port,
    token: resident ? undefined : token,
    consoleURL,
    pinnedHub,
    close: finish,
    closed: once(server, "close"),
  };
}

/** CLI 的 `ai-bridge pool setup`：起临时接口、把地址打出来、等它自己退出。 */
export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const handle = await startSetupServer({ ...options, resident: false });
  process.stdout.write(`本机配置接口已就绪：http://127.0.0.1:${handle.port}\n`);
  if (handle.consoleURL) {
    process.stdout.write(`在 Galaxy 控制台里完成配对：${handle.consoleURL}\n`);
  } else {
    // 连 Hub 地址都没有（pool 段还没配过）。把参数原样给出来让用户自己拼 ——
    // 没有这两个值，控制台就找不到本机接口，向导等于白起。
    process.stdout.write("没有控制台地址（--console / AI_BRIDGE_CONSOLE_URL）。把下面这段接到你的控制台地址后面：\n");
    process.stdout.write(`  /provider/overview#bridge=${handle.port}&t=${handle.token}\n`);
  }
  process.stdout.write("接口只监听本机、只认这一个令牌，配置完成或 15 分钟无操作后自动退出。\n");
  if (!handle.pinnedHub) {
    process.stdout.write("注意：这台机器还没配过 Hub，本次配对接受浏览器填入的任意平台地址。\n");
    process.stdout.write("      配过一次之后就会锁死，之后要换 Hub 得带 --hub 重跑。\n");
  }
  if (options.open !== false && handle.consoleURL) openBrowser(handle.consoleURL);

  await handle.closed;
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

/**
 * 在一个真终端窗口里跑命令，给交互式登录用。
 *
 * 只做 macOS：Linux 的终端模拟器五花八门（gnome-terminal / konsole /
 * x-terminal-emulator …），挨个试一遍还经常猜错，不如老实返回 false，
 * 让控制台把命令显示出来让人自己敲 —— 那条路在所有平台上都是通的。
 *
 * command 全部来自 LOGIN_COMMANDS 这张固定表，不含任何外部输入，所以这里
 * 拼进 osascript 是安全的；哪天要接受外部参数，这里必须先加转义。
 */
function openTerminal(command: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    spawn("/usr/bin/osascript", [
      "-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`,
      "-e", 'tell application "Terminal" to activate',
    ], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
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
