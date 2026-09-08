import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config/index.js";
import { Lane } from "../src/modules/pool/lane.js";
import { modelMatch, inlineJSON, inlineText, type WorkUnit } from "../src/business/core/index.js";
import type { ContributionDeclaration } from "../src/modules/pool/client.js";
import type { Provider } from "../src/business/core/index.js";

const providers = {
  claude: { type: "relay", authMode: "claude_oauth", baseURL: "https://api.anthropic.com/v1" },
  local: { type: "claude_code_local" },
};

const contribution = {
  id: "claude-main",
  upstream: "claude",
  quota: [{ unit: "llm.output_tokens", limit: 2_000_000, window: "day" }],
};

function poolConfig(overrides: Record<string, unknown> = {}) {
  return {
    mode: "pool",
    providers,
    relay: { enabled: false },
    pool: { hubURL: "https://hub.example.com", contributions: [contribution], ...overrides },
  };
}

test("pool 模式的贡献必须指向配了 baseURL 与 authMode 的 relay provider", () => {
  const cfg = parseConfig(poolConfig());
  assert.equal(cfg.mode, "pool");
  assert.equal(cfg.pool?.contributions[0].kind, "llm.chat");
  // 默认值照设计文档第 15 节的参数表
  assert.equal(cfg.pool?.contributions[0].seats, 3);
  assert.equal(cfg.pool?.contributions[0].seatConcurrency, 2);
  assert.equal(cfg.pool?.heartbeatSec, 15);
  assert.equal(cfg.pool?.nextWaitSec, 25);

  assert.throws(
    () => parseConfig(poolConfig({ contributions: [{ ...contribution, upstream: "local" }] })),
    /必须是配了 baseURL 的 relay/,
  );
  assert.throws(
    () => parseConfig(poolConfig({ contributions: [{ ...contribution, upstream: "missing" }] })),
    /不存在的 provider/,
  );
});

// 「一条启用的贡献都没有」现在是**合法**的。
//
// 共享哪几种由主人在 Galaxy 控制台定，节点启动时本来就不知道要跑什么 ——
// hello 之后 Hub 才把生效配置发下来。在配置解析这一层拦一道，等于逼着主人
// 先在本机配一遍才允许启动，和「配置界面在控制台」正好相反：进程得先跑起来、
// 先 hello 上去，主人才可能在控制台看到这台机器有什么能力可开。
test("pool 模式允许一条贡献都没有：共享什么由控制台定", () => {
  assert.doesNotThrow(() => parseConfig(poolConfig({ contributions: [] })));
  assert.doesNotThrow(() => parseConfig(poolConfig({ contributions: [{ ...contribution, enabled: false }] })));
});

test("pool 贡献 id 不能重复", () => {
  assert.throws(
    () => parseConfig(poolConfig({ contributions: [contribution, { ...contribution }] })),
    /重复/,
  );
});

test("mode=pool 少了 pool 配置段要直接报错，而不是静默起成 relay", () => {
  assert.throws(() => parseConfig({ mode: "pool", providers, relay: { enabled: false } }), /缺少 pool 配置段/);
});

test("额度至少要有一条：没上限的共享等于把机器交出去", () => {
  assert.throws(
    () => parseConfig(poolConfig({ contributions: [{ ...contribution, quota: [] }] })),
    /Invalid config/,
  );
});

// ---------- 通道闸门 ----------

const fakeProvider = {} as Provider;

function lane(seats = 2, seatConcurrency = 2): Lane {
  const cfg = parseConfig(poolConfig({
    contributions: [{ ...contribution, seats, seatConcurrency }],
  })).pool!.contributions[0];
  const declaration: ContributionDeclaration = {
    cid: cfg.id, kind: cfg.kind, kindVersion: cfg.kindVersion, provider: "claude_oauth",
    models: cfg.models, seats: cfg.seats, seatConcurrency: cfg.seatConcurrency,
    quota: [], schedule: [], upstreamOK: true,
  };
  return new Lane(cfg, declaration, fakeProvider);
}

test("单个消费者占不满整条通道：座位并发是每人各自的上限", () => {
  const target = lane(2, 2);
  assert.equal(target.capacity(), 4);
  assert.equal(target.acquire("ck_a"), true);
  assert.equal(target.acquire("ck_a"), true);
  // 第三条属于同一个消费者，超过 seatConcurrency=2
  assert.equal(target.acquire("ck_a"), false);
  // 换个消费者还有位置
  assert.equal(target.acquire("ck_b"), true);
  assert.equal(target.inflight, 3);

  target.release("ck_a");
  assert.equal(target.acquire("ck_a"), true);
});

test("通道满了之后谁都拿不到位置", () => {
  const target = lane(1, 2);
  assert.equal(target.capacity(), 2);
  assert.equal(target.acquire("ck_a"), true);
  assert.equal(target.acquire("ck_a"), true);
  assert.equal(target.acquire("ck_b"), false);
});

test("排空 / 暂停 / 凭据失效 / 被限流的通道报 0 空位", () => {
  const target = lane(3, 2);
  assert.equal(target.free(), 6);

  target.draining = true;
  assert.equal(target.free(), 0, "排空中不该再接新单");
  target.draining = false;

  target.paused = true;
  assert.equal(target.free(), 0, "主人按了紧急闸");
  target.paused = false;

  target.upstreamOK = false;
  assert.equal(target.free(), 0, "凭据失效的通道不该被派单");
  target.upstreamOK = true;

  target.throttledUntil = new Date(Date.now() + 60_000);
  assert.equal(target.free(), 0, "被上游限流时临时退出候选");
  target.throttledUntil = new Date(Date.now() - 1);
  assert.equal(target.free(), 6, "限流窗口过了要自动恢复");
});

// ---------- 白名单自校验 ----------

test("模型白名单与服务端同语义：deny 优先，allow 为空表示不限", () => {
  assert.equal(modelMatch("claude-sonnet-4-5", ["claude-sonnet-*"], []), true);
  assert.equal(modelMatch("claude-opus-4-1", ["claude-*"], ["claude-opus-*"]), false);
  assert.equal(modelMatch("anything", [], []), true);
  assert.equal(modelMatch("gpt-4o", ["claude-*"], []), false);
});

// ---------- 工作单元解码 ----------

test("工作单元的内联载荷按 base64 还原", () => {
  const unit = {
    id: "u_1", kind: "llm.chat", kindVersion: 1, primitive: "relay", provider: "claude_oauth",
    consumerKey: "ck_1", state: "running",
    inputs: [
      { name: "path", inline: Buffer.from("/v1/messages").toString("base64") },
      { name: "headers", inline: Buffer.from(JSON.stringify({ "anthropic-version": "2023-06-01" })).toString("base64") },
    ],
  } as WorkUnit;
  assert.equal(inlineText(unit, "path"), "/v1/messages");
  assert.deepEqual(inlineJSON(unit, "headers", {}), { "anthropic-version": "2023-06-01" });
  // 缺失的载荷返回兜底值，不抛
  assert.deepEqual(inlineJSON(unit, "missing", { ok: true }), { ok: true });
});

// ---------- 本机执行类贡献 ----------

test("本机执行类贡献要有 provider；agent 回合还必须显式给执行器命令", () => {
  const base = {
    mode: "pool", providers, relay: { enabled: false },
    pool: { hubURL: "https://hub.example.com", contributions: [] as unknown[] },
  };
  const withContribution = (contribution: unknown) =>
    parseConfig({ ...base, pool: { ...base.pool, contributions: [contribution] } });

  // 既没有上游也没有路由键：申报上去也没人能执行它。
  assert.throws(
    () => withContribution({ id: "x", kind: "video.edit.render", quota: [{ unit: "cpu.seconds", limit: 1 }] }),
    /没有任何东西能执行它/,
  );
  // agent 回合会在主人机器上跑命令，命令必须由主人自己写明。
  assert.throws(
    () => withContribution({
      id: "planner", kind: "delivery.task", provider: "delivery-task-planner",
      quota: [{ unit: "time.seconds", limit: 100 }],
    }),
    /必须用 exec 指定执行器命令/,
  );
  // ffmpeg 默认走 PATH，不强制写命令。
  const ok = withContribution({
    id: "ffmpeg", kind: "video.edit.render", provider: "ffmpeg-local",
    quota: [{ unit: "cpu.seconds", limit: 3600 }],
  });
  assert.equal(ok.pool?.contributions[0].provider, "ffmpeg-local");
});

test("同一节点可以同时贡献中转与本机执行两种能力", () => {
  const cfg = parseConfig({
    mode: "pool", providers, relay: { enabled: false },
    pool: {
      hubURL: "https://hub.example.com",
      contributions: [
        { id: "claude-main", upstream: "claude", quota: [{ unit: "llm.output_tokens", limit: 1 }] },
        {
          id: "planner", kind: "delivery.task", provider: "delivery-task-planner",
          exec: { command: "/bin/worker" },
          quota: [{ unit: "time.seconds", limit: 1 }],
        },
      ],
    },
  });
  assert.equal(cfg.pool?.contributions.length, 2);
  // 未贡献的能力不加载：主人没勾的东西，代码都不该被 import（X-03）。
  assert.equal(cfg.pool?.contributions[1].exec?.command, "/bin/worker");
});
