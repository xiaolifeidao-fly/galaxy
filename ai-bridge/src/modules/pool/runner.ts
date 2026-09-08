import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, PoolConfig, PoolContribution } from "../../config/schema.js";
import { CredentialRegistry } from "../../credentials/index.js";
import { log } from "../../core/logger.js";
import {
  modelMatch,
  type ArtifactRef, type Metering, type Provider, type UnitEvent, type WorkUnit,
} from "../../business/core/index.js";
import { RelayProvider } from "../../business/llm-chat/node/relay-provider.js";
import { PlannerBridgeProvider } from "../../business/delivery-task/node/planner-bridge.js";
import { FfmpegLocalProvider } from "../../business/video-edit/node/ffmpeg-local.js";
import {
  ContractMismatchError, HubClient,
  type CapabilityReport, type EnabledContribution, type NextResult,
} from "./client.js";
import { Lane, type LaneConfig } from "./lane.js";
import { listModels } from "./models.js";
import { localResources, probe } from "./probe.js";
import { fingerprint, readNodeIdentity, resolveNodeTokenFile } from "./token.js";

// pool 模式的运行循环。
//
// 进程不 listen 任何端口（P-15）：主循环是「长轮询领活 → 跑 provider → 上行推流 → 报终态」，
// 心跳线程每 15s 一次，取消信号搭在这两条已有链路上，不单独轮询（T-05）。

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface PoolRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createPoolRunner(cfg: AppConfig): Promise<PoolRunner> {
  const pool: PoolConfig | undefined = cfg.pool;
  if (!pool) throw new Error("mode=pool 但缺少 pool 配置段");
  // 把窄化后的值绑成不可空的局部量：下面几个闭包都要用，逐个加 ! 只会掩盖真问题。
  const settings: PoolConfig = pool;

  const nodeIdentity = await readNodeIdentity(resolveNodeTokenFile(settings));
  if (!nodeIdentity) {
    throw new Error("还没有配对过。先在控制台生成配对码，再运行 ai-bridge pool pair <code>");
  }
  const identity = nodeIdentity;
  const bridgeVersion = await readVersion();
  const client = new HubClient(settings.hubURL, settings.contract, identity.token, identity.nodeId);
  const credentials = new CredentialRegistry();

  // 通道是**跟着 Hub 下发的集合动态增删的**，不是启动时按本地配置建好的。
  //
  // 「共享哪几种、共享多少」现在由主人在控制台定，Hub 每次 hello / 心跳带回来一份
  // 生效配置，这里照着对齐。本机配置文件里的 pool.contributions 不再参与决策 ——
  // 主人想改设置不必回到这台机器，改完最迟一个心跳周期就生效。
  const lanes = new Map<string, Lane>();
  // inventory 是本机探测到的能力，cid → 建 provider 需要的本地信息。
  // 它决定「能不能建这条通道」，Hub 决定「要不要建」。
  let inventory = new Map<string, LocalCapability>();

  const aborts = new Map<string, AbortController>();
  let stopping = false;
  let loopSignal = new AbortController();

  // refreshInventory 重新探一遍本机能力。凭据会过期、ffmpeg 会被卸载，
  // 所以每次 hello 都探，不只探一次。
  async function refreshInventory(): Promise<CapabilityReport[]> {
    const probed = await probe(cfg);
    const next = new Map<string, LocalCapability>();
    const reports: CapabilityReport[] = [];
    for (const capability of probed.capabilities) {
      const local = localCapability(capability, cfg, credentials);
      if (!local) continue;
      next.set(local.cid, local);
      // 只给「可用」的能力列模型：不可用时凭据本来就解析不了，去问上游只是白等一次超时。
      // listModels 自己带 6 小时缓存，所以 hello 再频繁也不会变成对上游的压力。
      const upstream = capability.upstream;
      const provider = upstream ? cfg.providers[upstream] : undefined;
      const models =
        capability.available && upstream && provider
          ? await listModels(upstream, provider, credentials)
          : undefined;
      reports.push({
        cid: local.cid, kind: local.kind, kindVersion: local.kindVersion, provider: local.routeKey,
        available: capability.available,
        unavailableReason: capability.available ? undefined : capability.detail,
        ...(models?.length ? { availableModels: models } : {}),
      });
      if (!capability.available) {
        log.warn("pool_upstream_unavailable", { cid: local.cid, detail: capability.detail });
      }
    }
    inventory = next;
    return reports;
  }

  /**
   * applyEnabled 把本地通道对齐到 Hub 下发的集合。
   *
   * 三种情形分开处理：
   *   新增 —— Hub 要，本地没有：建通道（本机得真有这个能力，否则只记一条日志）
   *   变更 —— 两边都有：**原地换配置**，不重建。重建会把 inflight 计数清零，
   *           正在跑的请求就变成了「没人认领的并发」，闸门当场失准。
   *   移除 —— Hub 不要了（主人关掉了）：先置 draining 停止接新单，
   *           等在跑的跑完再真拆。直接删会把跑到一半的请求连同 abort 控制器一起丢掉。
   */
  function applyEnabled(enabled: EnabledContribution[] | undefined): void {
    // undefined 表示对面是老版本 Hub，没有这个字段 —— 维持现状。
    // 空数组才是「一条都别跑」。两者混同会让一次版本不匹配把所有通道停掉。
    if (!enabled) return;
    const wanted = new Map(enabled.map((item) => [item.cid, item]));

    for (const [cid, want] of wanted) {
      const local = inventory.get(cid);
      if (!local) {
        log.warn("pool_enabled_not_probed", { cid, hint: "控制台开着这条贡献，但本机没探测到这个能力" });
        continue;
      }
      const config = laneConfig(want);
      const existing = lanes.get(cid);
      if (existing) {
        existing.config = config;
        continue;
      }
      lanes.set(cid, new Lane(config, local.build()));
      log.info("pool_lane_added", { cid, kind: want.kind, seats: want.seats });
    }

    for (const [cid, lane] of [...lanes]) {
      if (wanted.has(cid)) continue;
      lane.draining = true;
      if (lane.inflight === 0) {
        lanes.delete(cid);
        log.info("pool_lane_removed", { cid });
      } else {
        log.info("pool_lane_draining", { cid, inflight: lane.inflight });
      }
    }
  }

  async function sayHello(): Promise<void> {
    const reports = await refreshInventory();
    const result = await client.hello({
      bridgeVersion,
      contract: settings.contract,
      resources: localResources(),
      contributions: reports,
    });
    for (const rejected of result.rejected ?? []) {
      log.error("pool_capability_rejected", { cid: rejected.cid, reason: rejected.reason });
    }
    applyEnabled(result.enabled);
    log.info("pool_hello", {
      nodeId: identity.nodeId, token: fingerprint(identity.token),
      probed: reports.length, enabled: lanes.size, hub: settings.hubURL,
    });
    if (lanes.size === 0) {
      log.warn("pool_nothing_enabled", {
        hint: "本机没有任何通道在跑：去控制台的「贡献授权」把要共享的能力打开并给上额度",
      });
    }
  }

  async function heartbeatLoop(): Promise<void> {
    while (!stopping) {
      try {
        const result = await client.heartbeat([...lanes.values()].map((lane) => ({
          cid: lane.cid,
          inflight: lane.inflight,
          queued: 0,
          throttledUntil: lane.throttledUntil ? lane.throttledUntil.toISOString() : null,
          upstreamOK: lane.upstreamOK,
          paused: lane.paused,
        })));
        // 取消搭在心跳的响应里：延迟不超过一个上报周期（T-05）。
        for (const unitId of result.cancel ?? []) {
          aborts.get(unitId)?.abort(new Error("hub_cancelled"));
        }
        const draining = new Set(result.drain ?? []);
        for (const lane of lanes.values()) {
          lane.draining = draining.has(lane.cid);
        }
        // 主人在控制台改了什么，最迟一个心跳周期就换过来 ——「随时随地能调」
        // 就是这一行。注意它在 draining 之后：applyEnabled 会把被关掉的通道
        // 重新置成 draining，顺序反了会被上面那个循环立刻清掉。
        applyEnabled(result.enabled);
      } catch (e) {
        log.warn("pool_heartbeat_failed", { message: (e as Error)?.message });
      }
      await sleep(settings.heartbeatSec * 1000);
    }
  }

  async function nextLoop(): Promise<void> {
    let backoff = RECONNECT_MIN_MS;
    while (!stopping) {
      const free = [...lanes.values()]
        .map((lane) => ({ cid: lane.cid, free: lane.free() }))
        .filter((entry) => entry.free > 0);
      if (free.length === 0) {
        // 所有通道都满了或都在排空：别去长轮询，白占一条连接。
        await sleep(1_000);
        continue;
      }
      try {
        const claimed = await client.next(free, settings.nextWaitSec, loopSignal.signal);
        backoff = RECONNECT_MIN_MS;
        if (!claimed) continue;
        for (const unitId of claimed.cancel ?? []) {
          aborts.get(unitId)?.abort(new Error("hub_cancelled"));
        }
        if (!claimed.unit?.id) continue;
        void dispatch(claimed);
      } catch (e) {
        if (stopping) return;
        log.warn("pool_next_failed", { message: (e as Error)?.message, retryInMs: backoff });
        await sleep(backoff + Math.floor(Math.random() * 500));
        backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
      }
    }
  }

  // dispatch 跑一个工作单元。首字节之前失败可以被 Hub 改派，
  // 之后失败只能 502 —— 已经流出去的字节收不回来（设计文档 6.2）。
  async function dispatch(claimed: NextResult): Promise<void> {
    const unit = claimed.unit;
    const lane = resolveLane(unit);
    if (!lane) {
      await client.complete(unit.id, {
        lease: claimed.lease.token, state: "failed",
        error: { class: "node_fault", code: "capability_mismatch", retryable: true, message: "单元不在本机任何贡献的申报范围内" },
      });
      return;
    }
    if (!lane.acquire(unit.consumerKey)) {
      await client.complete(unit.id, {
        lease: claimed.lease.token, state: "failed",
        error: { class: "node_fault", code: "capability_mismatch", retryable: true, message: "通道已满" },
      });
      return;
    }

    const abort = new AbortController();
    aborts.set(unit.id, abort);
    const startedAt = Date.now();
    // 每个单元一个临时目录，结束后整个删掉：消费者的素材不该在主人机器上留过夜（约束 4）。
    const workDir = join(tmpdir(), "ai-bridge-unit", unit.id);
    // 续租心跳：job 可以跑两小时，租约只有 60 秒。不续的话 Hub 会判它跑丢了，
    // 把同一个任务派给另一台机器重跑一遍 —— 两台机器同时渲染同一条时间线。
    const renewEvery = Math.max(15_000, (claimed.lease.renewSec || 60) * 500);
    const renew = setInterval(() => {
      void client.progress(unit.id, { lease: claimed.lease.token, renew: true })
        .then((result) => {
          // 取消搭在续租的响应里回来，不单独轮询（T-05）。
          if (result.cancelRequested) abort.abort(new Error("hub_cancelled"));
        })
        .catch((e) => log.debug("pool_renew_failed", { unitId: unit.id, message: (e as Error)?.message }));
    }, renewEvery);
    renew.unref?.();
    // 终态在下面的生成器闭包里被写。用 UnitOutcome 而不是裸变量：
    // TS 看不到闭包里的赋值，会把普通变量在后续分支里一路收窄成 never。
    const outcome = new UnitOutcome();

    try {
      const iterator = lane.provider.run(unit, {
        signal: abort.signal,
        log: (message, meta) => log.debug(message, { unitId: unit.id, cid: lane.cid, ...meta }),
        workDir,
        signArtifact: (name, contentType, size) => client.signArtifact(unit.id, { name, contentType, size }),
        progress: (pct, stage, previewRef) => client.progress(unit.id, {
          lease: claimed.lease.token, progress: { pct, stage, previewRef }, renew: true,
        }),
      })[Symbol.asyncIterator]();

      // 先等到 head：上行连接的状态码与响应头要在建连时就带上。
      let head: Extract<UnitEvent, { type: "head" }> | undefined;
      for (;;) {
        const step = await iterator.next();
        if (step.done) break;
        if (step.value.type === "head") { head = step.value; break; }
        if (step.value.type === "error") { outcome.fail(step.value); break; }
        if (step.value.type === "done") { outcome.finish(step.value); break; }
      }

      const earlyFailure = outcome.failure();
      if (earlyFailure) {
        await client.complete(unit.id, {
          lease: claimed.lease.token,
          state: earlyFailure.code === "unit_cancelled" ? "cancelled" : "failed",
          error: { class: earlyFailure.class, code: earlyFailure.code, retryable: earlyFailure.retryable, message: earlyFailure.message },
          ms: Date.now() - startedAt,
        });
        return;
      }
      if (!head) {
        await client.complete(unit.id, {
          lease: claimed.lease.token, state: "completed", usage: outcome.usage(),
          ...outcome.terminal(), ms: Date.now() - startedAt,
        });
        return;
      }

      // 剩下的事件就是响应字节。边收边推，背压顺着这条连接顶回上游 fetch。
      async function* chunks(): AsyncIterable<Uint8Array> {
        for (;;) {
          const step = await iterator.next();
          if (step.done) return;
          const event = step.value;
          if (event.type === "chunk") { yield event.bytes; continue; }
          if (event.type === "done") { outcome.finish(event); return; }
          if (event.type === "error") { outcome.fail(event); return; }
        }
      }

      const result = await client.stream(claimed.streamURL, {
        status: head.status, headers: head.headers, lease: claimed.lease.token,
        body: chunks(), signal: abort.signal,
      });

      if (result.consumerGone) {
        // 410：消费者走了，立刻 abort 上游，不再烧主人的额度。
        abort.abort(new Error("consumer_gone"));
        await client.complete(unit.id, { lease: claimed.lease.token, state: "cancelled", usage: outcome.usage(), ms: Date.now() - startedAt });
        return;
      }
      const streamFailure = outcome.failure();
      if (streamFailure) {
        await client.complete(unit.id, {
          lease: claimed.lease.token, state: "failed",
          error: { class: streamFailure.class, code: streamFailure.code, retryable: streamFailure.retryable, message: streamFailure.message },
          usage: outcome.usage(), ...outcome.terminal(), ms: Date.now() - startedAt,
        });
        return;
      }
      await client.complete(unit.id, {
        lease: claimed.lease.token, state: "completed", usage: outcome.usage(),
        ...outcome.terminal(), ms: Date.now() - startedAt,
      });
    } catch (e) {
      const cancelled = abort.signal.aborted;
      await client.complete(unit.id, {
        lease: claimed.lease.token,
        state: cancelled ? "cancelled" : "failed",
        error: cancelled ? null : {
          class: "node_fault", code: "node_offline", retryable: true,
          message: (e as Error)?.message ?? "节点执行失败",
        },
        ms: Date.now() - startedAt,
      });
    } finally {
      clearInterval(renew);
      aborts.delete(unit.id);
      lane.release(unit.consumerKey);
      // 清场：本机不留消费者内容。删不掉只记日志，不影响这个单元已经报出去的终态。
      await rm(workDir, { recursive: true, force: true })
        .catch((e) => log.warn("pool_workdir_cleanup_failed", { unitId: unit.id, message: (e as Error)?.message }));
      // 日志只记 requestId / cid，不记内容也不记消费者身份。
      log.info("pool_unit_done", { unitId: unit.id, cid: lane.cid, ms: Date.now() - startedAt });
    }
  }

  // resolveLane 是节点侧的白名单自校验（原则 8）。Hub 是路由权威，
  // 但「在我的机器上执行什么」这条边界不信任 Hub。
  function resolveLane(unit: WorkUnit): Lane | undefined {
    for (const lane of lanes.values()) {
      if (lane.config.kind !== unit.kind || lane.config.kindVersion !== unit.kindVersion) continue;
      if (lane.config.provider !== unit.provider) continue;
      if (unit.model && !modelMatch(unit.model, lane.config.models.allow, lane.config.models.deny)) continue;
      return lane;
    }
    return undefined;
  }

  return {
    async start() {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await sayHello();
          if (attempt > 1) log.info("pool_hello_recovered", { attempt });
          break;
        } catch (e) {
          if (e instanceof ContractMismatchError) {
            // 契约不匹配是升级问题，不是网络抖动：立刻停，别把重试打成死循环。
            log.error("pool_contract_mismatch", { message: e.message });
            throw e;
          }
          const message = (e as Error)?.message ?? "";
          // 令牌被拒不是网络抖动，重试多少次都不会自己好。但也**不能直接退出**：
          // 主人很可能正在控制台里重新配对，进程活着才能在配对完之后自动接上。
          // 所以只把「该怎么办」在第一次就说清楚，之后退避到上限，别每秒刷一条。
          if (/令牌无效|未授权|已撤销|revoked|unauthorized/i.test(message) && attempt === 1) {
            log.error("pool_node_token_rejected", {
              message,
              hint: "这台机器的节点令牌 Hub 不认了。打开 Galaxy 控制台「加入共享池」，生成配对码重新配对即可，不用回到这台机器。",
            });
          } else {
            log.warn("pool_hello_failed", { message, attempt });
          }
          // 指数退避封顶：连不上 Hub 时不该把日志和 CPU 都刷满。
          const wait = Math.min(RECONNECT_MIN_MS * 2 ** Math.min(attempt - 1, 6), RECONNECT_MAX_MS);
          await sleep(wait);
        }
      }
      void heartbeatLoop();
      void nextLoop();
      log.info("pool_started", { nodeId: identity.nodeId, lanes: [...lanes.keys()] });
    },
    async stop() {
      stopping = true;
      loopSignal.abort(new Error("shutdown"));
      loopSignal = new AbortController();
      for (const controller of aborts.values()) controller.abort(new Error("shutdown"));
      log.info("pool_stopped");
    },
  };
}

// UnitOutcome 收集一次执行的终态。做成对象而不是两个变量，是为了让写入发生在
// 闭包里、读取发生在主流程里时，类型不被控制流分析误收窄。
class UnitOutcome {
  private value: Metering = {};
  private cause?: Extract<UnitEvent, { type: "error" }>;
  private done?: Extract<UnitEvent, { type: "done" }>;

  finish(event: Extract<UnitEvent, { type: "done" }>): void {
    this.value = event.usage ?? {};
    this.done = event;
  }

  // terminal 是终态里除用量之外的东西：session 的上下文增量、job 的产物引用。
  // relay 没有这一层，返回空对象。
  terminal(): {
    contextDelta?: unknown;
    workspaceRef?: unknown;
    checkpointRef?: unknown;
    outputs?: Array<{ name: string; ref: ArtifactRef }>;
  } {
    if (!this.done) return {};
    return {
      contextDelta: this.done.contextDelta,
      workspaceRef: this.done.workspaceRef,
      checkpointRef: this.done.checkpointRef,
      outputs: this.done.outputs,
    };
  }

  fail(event: Extract<UnitEvent, { type: "error" }>): void {
    this.cause = event;
  }

  usage(): Metering {
    return this.value;
  }

  failure(): Extract<UnitEvent, { type: "error" }> | undefined {
    return this.cause;
  }
}

// routeProvider 算出这条贡献的路由键。中转类由 upstream 的 authMode 推出来，
// 本机执行类在配置里显式写 —— 它没有「上游是谁」这回事。
function routeProvider(contribution: PoolContribution, cfg: AppConfig): string | undefined {
  if (contribution.upstream) return cfg.providers[contribution.upstream]?.authMode;
  return contribution.provider;
}

function buildProvider(
  contribution: PoolContribution,
  routeKey: string,
  cfg: AppConfig,
  credentials: CredentialRegistry,
): Provider {
  switch (contribution.kind) {
    case "llm.chat": {
      if (!contribution.upstream) throw new Error(`贡献 ${contribution.id} 缺少 upstream`);
      return new RelayProvider({
        name: routeKey,
        provider: cfg.providers[contribution.upstream],
        credentials,
      });
    }
    case "delivery.task": {
      if (!contribution.exec) throw new Error(`贡献 ${contribution.id} 缺少 exec，无法执行回合`);
      return new PlannerBridgeProvider({ name: routeKey, exec: contribution.exec });
    }
    case "video.edit.render":
      return new FfmpegLocalProvider({
        name: routeKey,
        binary: contribution.exec?.command,
        extraArgs: contribution.exec?.args,
      });
    default:
      throw new Error(`本节点不支持能力 ${contribution.kind}；升级 ai-bridge 或去掉这条贡献`);
  }
}

/**
 * LocalCapability 是本机对一项能力知道、而 Hub 不知道的那部分：
 * 拿哪一份订阅登录态、跑哪个可执行文件。Hub 只发「要不要、给多少」，
 * 「怎么跑」永远留在本机 —— 凭据不出本机这条就靠它。
 */
interface LocalCapability {
  cid: string;
  kind: string;
  kindVersion: number;
  /** routeKey 是放置用的 provider 路由键（中转类由订阅类型推出，本机执行类是模块名）。 */
  routeKey: string;
  /** build 惰性建执行器：Hub 没开启的能力不会被调用，相关代码也就不加载（X-03）。 */
  build: () => Provider;
}

/**
 * localCapability 把一条探测结果映射成「本机怎么跑它」。
 *
 * cid 用配置键（中转类）或模块名（本机执行类）：它要在这台机器上唯一，
 * 而且要能在控制台上被主人认出来。Hub 侧会再加 nodeId 前缀消歧（设计 2.7）。
 *
 * kindVersion 固定 1：适配器目前都是 v1，探测结果里没有这一项。
 * 将来出现 v2 时这里要跟着改，否则会把 v2 的能力报成 v1。
 */
function localCapability(
  capability: { kind: string; provider: string; upstream?: string },
  cfg: AppConfig,
  credentials: CredentialRegistry,
): LocalCapability | undefined {
  const kindVersion = 1;
  switch (capability.kind) {
    case "llm.chat": {
      const upstream = capability.upstream;
      if (!upstream || !cfg.providers[upstream]) return undefined;
      return {
        cid: upstream, kind: capability.kind, kindVersion, routeKey: capability.provider,
        build: () => new RelayProvider({
          name: capability.provider, provider: cfg.providers[upstream], credentials,
        }),
      };
    }
    case "video.edit.render":
      return {
        cid: capability.provider, kind: capability.kind, kindVersion, routeKey: capability.provider,
        build: () => new FfmpegLocalProvider({ name: capability.provider }),
      };
    default:
      // delivery.task 不在这里：它的执行器是主人自己写的命令，探测不出来。
      return undefined;
  }
}

function laneConfig(want: EnabledContribution): LaneConfig {
  return {
    id: want.cid,
    kind: want.kind,
    kindVersion: want.kindVersion,
    provider: want.provider,
    seats: want.seats,
    seatConcurrency: want.seatConcurrency,
    models: { allow: want.modelsAllow ?? [], deny: want.modelsDeny ?? [] },
  };
}

async function readVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, "..", "..", "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 定时器**不能** unref。
 *
 * 这里的每一次 sleep 都在一个「进程活着就该继续转」的循环里：hello 重连、心跳、
 * 取任务退避。unref 掉之后，只要所有循环同时处在 sleep 上、又没有在途请求撑着，
 * 事件循环就空了，Node 会**以退出码 0 干净退出** —— 表现为节点连不上 Hub 时
 * 直接消失，而 supervisor 看到「正常退出」又把它拉起来，变成固定间隔的重启循环，
 * 控制台上这台机器则一直是离线。退出码 0 还会骗过 Restart=on-failure 这类策略。
 *
 * 停止不靠事件循环耗尽，靠 stop() 里的 abort + 显式 process.exit。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
