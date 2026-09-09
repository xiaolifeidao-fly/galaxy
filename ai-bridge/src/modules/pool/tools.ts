import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { log } from "../../core/logger.js";

const execFileAsync = promisify(execFile);

/**
 * 本机这几个工具的版本与可升级状态，给控制台显示。
 *
 * 为什么版本要问 CLI 自己而不是读 npm：claude 的 bin 指向的是原生构建
 * （claude.exe），实测 `claude --version` 报 2.1.263 而 npm 包是 2.1.266 ——
 * 读 npm 会显示一个用户根本没在跑的版本。
 *
 * 「最新版」要走网络，所以缓存 30 分钟：这个面板每次进页面都会拉，
 * 不缓存等于每次刷新都打三次 npm registry。
 */

const LATEST_TTL_MS = 30 * 60 * 1000;
const EXEC_TIMEOUT_MS = 20_000;

export interface ToolStatus {
  name: string;
  /** 本机正在跑的版本。取不到就是没装。 */
  current: string;
  /** 上游最新版。取不到（网络不通等）就是空串，此时不判定可升级。 */
  latest: string;
  /** 只有两边都拿得到、且不相等，才算可升级 —— 拿不到就别催人升级。 */
  upgradable: boolean;
  /** 没装的工具不显示升级按钮，显示「未安装」。 */
  installed: boolean;
}

interface Cached {
  at: number;
  value: string;
}

const latestCache = new Map<string, Cached>();

/** 只给测试用。 */
export function clearToolCache(): void {
  latestCache.clear();
}

async function run(file: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { encoding: "utf8", timeout: EXEC_TIMEOUT_MS, cwd });
  return stdout.trim();
}

/** 从 `codex-cli 0.153.4` / `2.1.263 (Claude Code)` 这类输出里抠出版本号。 */
export function parseVersion(raw: string): string {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(raw)?.[1] ?? "";
}

async function npmLatest(pkg: string): Promise<string> {
  const hit = latestCache.get(pkg);
  if (hit && Date.now() - hit.at < LATEST_TTL_MS) return hit.value;
  try {
    const value = parseVersion(await run("npm", ["view", pkg, "version"]));
    latestCache.set(pkg, { at: Date.now(), value });
    return value;
  } catch (e) {
    log.warn("tool_latest_unavailable", { pkg, message: (e as Error)?.message });
    return "";
  }
}

async function cliVersion(command: string): Promise<string> {
  try {
    return parseVersion(await run(command, ["--version"]));
  } catch {
    return "";
  }
}

/** 插件自己的安装目录：dist/modules/pool → 上溯四层到包根。 */
export function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * ai-bridge 的「版本」用 git commit，不用 package.json 里的版本号 ——
 * 那个一直是 0.1.0，从来不 bump，拿它比对永远显示「已是最新」。
 */
async function bridgeStatus(): Promise<ToolStatus> {
  const root = pluginRoot();
  let current = "";
  let latest = "";
  try {
    current = (await run("git", ["rev-parse", "--short", "HEAD"], root)).trim();
    const remote = await run("git", ["ls-remote", "origin", "HEAD"], root);
    // git ls-remote 回的是完整 sha + \t + ref，取前 7 位和 --short 对齐。
    latest = remote.split(/\s+/)[0]?.slice(0, current.length) ?? "";
  } catch (e) {
    log.warn("tool_bridge_version_unavailable", { message: (e as Error)?.message });
  }
  let packageVersion = "";
  try {
    packageVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version ?? "";
  } catch {
    /* 读不到就不显示 */
  }
  return {
    name: "ai-bridge",
    current: packageVersion && current ? `${packageVersion} (${current})` : current,
    latest,
    upgradable: Boolean(current && latest && current !== latest),
    installed: Boolean(current),
  };
}

export async function toolStatuses(): Promise<ToolStatus[]> {
  const [claude, claudeLatest, codex, codexLatest, bridge] = await Promise.all([
    cliVersion("claude"),
    npmLatest("@anthropic-ai/claude-code"),
    cliVersion("codex"),
    npmLatest("@openai/codex"),
    bridgeStatus(),
  ]);
  return [
    bridge,
    {
      name: "claude",
      current: claude,
      latest: claudeLatest,
      // 两边都拿得到才判定 —— 网络不通时不该显示一个「可升级」的假信号。
      upgradable: Boolean(claude && claudeLatest && claude !== claudeLatest),
      installed: Boolean(claude),
    },
    {
      name: "codex",
      current: codex,
      latest: codexLatest,
      upgradable: Boolean(codex && codexLatest && codex !== codexLatest),
      installed: Boolean(codex),
    },
  ];
}

/**
 * 升级命令。**只认这张表**，请求体里只能传工具名 —— 和 LOGIN_COMMANDS 同一个道理。
 *
 * npm 那两个是幂等的普通命令，headless 跑没问题（不像 claude auth login 要 TTY）。
 * ai-bridge 是自己升自己，见 upgradeBridge 的说明。
 */
const UPGRADE_COMMANDS: Record<string, string[]> = {
  claude: ["npm", "install", "-g", "@anthropic-ai/claude-code@latest"],
  codex: ["npm", "install", "-g", "@openai/codex@latest"],
};

/**
 * ai-bridge 自升级：拉代码 → 重装依赖 → 重编译 → 让 supervisor 把自己重启。
 *
 * 必须**脱离当前进程**跑（detached + 独立 shell）：最后一步会杀掉自己，
 * 挂在自己身上的子进程会跟着一起死，升到一半就断了。
 *
 * 重启交给 supervisor 而不是自己 exec：LaunchAgent / systemd 本来就会在进程
 * 退出后拉起来，这是最省事也最可靠的一条 —— 和自动更新那套「退出让 supervisor
 * 接手」是同一个模式。
 */
function upgradeBridge(): void {
  const root = pluginRoot();
  const label = "com.galaxy.ai-bridge";
  const restart = process.platform === "darwin"
    ? `launchctl kickstart -k gui/$(id -u)/${label}`
    : `systemctl --user restart ai-bridge.service`;
  const script = [
    `cd ${JSON.stringify(root)} || exit 1`,
    "git pull --ff-only || exit 1",
    "npm ci --no-audit --no-fund || exit 1",
    "npm run build || exit 1",
    restart,
  ].join(" && ");
  spawn("/bin/bash", ["-lc", script], { stdio: "ignore", detached: true }).unref();
}

/**
 * 拉起一次升级。**立刻返回**，不等它跑完 ——
 * npm 全局安装动辄几十秒，HTTP 上干等只会超时；跑完与否由下次查版本体现。
 */
export function upgradeTool(name: string): { command: string } {
  if (name === "ai-bridge") {
    upgradeBridge();
    return { command: "git pull && npm ci && npm run build && <restart>" };
  }
  const argv = UPGRADE_COMMANDS[name];
  if (!argv) throw new Error(`不认识的工具：${name}`);
  spawn(argv[0], argv.slice(1), { stdio: "ignore", detached: true }).unref();
  log.info("tool_upgrade_launched", { tool: name, command: argv.join(" ") });
  return { command: argv.join(" ") };
}
