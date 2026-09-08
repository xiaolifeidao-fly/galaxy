import type { Provider } from "../../business/core/index.js";

/**
 * 一条通道的运行期配置。
 *
 * 它**不是**本地配置文件里的那个 PoolContribution：共享什么、共享多少现在由主人
 * 在控制台定，Hub 每次心跳下发一份，节点照着建通道。这里只留 Lane 真正用得上的
 * 那几项，免得为了造一条通道去凑一个完整的配置对象。
 */
export interface LaneConfig {
  id: string;
  kind: string;
  kindVersion: number;
  /** 放置用的 provider 路由键。节点侧的白名单自校验要拿它比对派下来的单元。 */
  provider: string;
  seats: number;
  seatConcurrency: number;
  models: { allow: string[]; deny: string[] };
}

// 一条通道 = 一个贡献在节点侧的运行态。座位、并发、排空、限流都按它算。
//
// 这里的并发闸门与 core/queue.ts 的三层闸门是两回事：那一层管的是本机客户端，
// 这一层管的是共享池派下来的单元，两者的上限由主人分别配置。
export class Lane {
  inflight = 0;
  draining = false;
  paused = false;
  upstreamOK = true;
  throttledUntil?: Date;
  private readonly perConsumer = new Map<string, number>();

  constructor(
    // config 是可变的：主人在控制台改座位或模型范围时原地换掉，不重建通道 ——
    // 重建会把 inflight 计数清零，正在跑的请求就成了没人认领的并发。
    public config: LaneConfig,
    readonly provider: Provider,
  ) {}

  get cid(): string {
    return this.config.id;
  }

  // capacity 是这条通道的总并发：座位数 × 单座位并发。
  capacity(): number {
    return this.config.seats * this.config.seatConcurrency;
  }

  // free 是这一轮 next 要报给 Hub 的空位数。排空 / 暂停 / 凭据失效时报 0，
  // Hub 就不会再往这条队列上派单，在跑的照常跑完。
  free(): number {
    if (this.draining || this.paused || !this.upstreamOK) return 0;
    if (this.throttledUntil && this.throttledUntil > new Date()) return 0;
    return Math.max(0, this.capacity() - this.inflight);
  }

  // acquire 占一个执行位。单个消费者在这条通道上的并行数不能超过 seatConcurrency，
  // 否则一个人就能把整台机器占满。
  acquire(consumerKey: string): boolean {
    if (this.inflight >= this.capacity()) return false;
    const used = this.perConsumer.get(consumerKey) ?? 0;
    if (used >= this.config.seatConcurrency) return false;
    this.perConsumer.set(consumerKey, used + 1);
    this.inflight += 1;
    return true;
  }

  release(consumerKey: string): void {
    const used = (this.perConsumer.get(consumerKey) ?? 1) - 1;
    if (used <= 0) this.perConsumer.delete(consumerKey);
    else this.perConsumer.set(consumerKey, used);
    this.inflight = Math.max(0, this.inflight - 1);
  }
}
