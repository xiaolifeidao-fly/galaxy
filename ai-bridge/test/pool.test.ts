import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config/index.js";
import { Lane } from "../src/modules/pool/lane.js";
import { healthSignature, sleep } from "../src/modules/pool/runner.js";
import { parseModels } from "../src/modules/pool/models.js";
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

test("sleep 的定时器必须保活事件循环", async () => {
  // 守一个静默故障：sleep 曾经写成 setTimeout(...).unref()，于是每一个重试循环
  // （hello 重连、心跳、取任务退避）都不再保活。连不上 Hub 时事件循环直接空掉，
  // 进程**以退出码 0** 消失，supervisor 看到「正常退出」又拉起来 —— 变成固定间隔
  // 的重启循环，而控制台上这台机器一直显示离线；退出码 0 还会骗过 Restart=on-failure。
  //
  // 把 unref 加回去不会让任何别的测试变红（它们不跑真实循环），所以只能钉在这里。
  const count = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const before = count();
  const pending = sleep(30);
  assert.equal(count(), before + 1, "sleep 的定时器没有保活事件循环（多半是又被 unref 了）");
  await pending;
});

// ---------- 上游模型清单解析 ----------
//
// 这份清单会变成控制台里「只放这些模型」的候选项。解析错了不会报错、只会安静地
// 少几个候选或者多出垃圾项，而主人会照着垃圾项配出一条永远匹配不上的规则。

test("认 OpenAI / Anthropic 的 {data:[{id}]} 形状", () => {
  const models = parseModels({ data: [{ id: "claude-opus-4" }, { id: "claude-sonnet-4" }] });
  assert.deepEqual(models, ["claude-opus-4", "claude-sonnet-4"]);
});

test("也认少数网关的 {models:[\"...\"]} 形状", () => {
  assert.deepEqual(parseModels({ models: ["gpt-a", "gpt-b"] }), ["gpt-a", "gpt-b"]);
});

test("去重并排序：同一个模型在分页结果里出现两次不该变成两个候选", () => {
  assert.deepEqual(parseModels({ data: [{ id: "b" }, { id: "a" }, { id: "b" }] }), ["a", "b"]);
});

test("认 Codex 后端的 {models:[{slug}]} 形状", () => {
  // 这一条是踩过的坑：Codex 返回的条目用 slug 不用 id。只认 id 的话请求明明
  // 成功了、解析出来还是空，而日志里什么异常都没有 —— 最难查的那种。
  const models = parseModels({ models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.4-mini" }] });
  assert.deepEqual(models, ["gpt-5.4-mini", "gpt-5.5"]);
});

test("id 和 slug 混着来也认", () => {
  assert.deepEqual(parseModels({ data: [{ id: "a" }, { slug: "b" }] }), ["a", "b"]);
});

test("认不出来的形状一律当空，不猜", () => {
  // 猜错的模型名比没有更糟：主人会照着它配出一条永远匹配不上的规则，
  // 然后以为是共享池坏了。
  for (const junk of [null, undefined, {}, { data: "nope" }, { data: [1, 2] }, "text", []]) {
    assert.deepEqual(parseModels(junk), [], `不该从 ${JSON.stringify(junk)} 解析出模型`);
  }
});

test("丢掉空串和非字符串的 id", () => {
  assert.deepEqual(parseModels({ data: [{ id: "" }, { id: "  " }, { id: 5 }, { id: "ok" }] }), ["ok"]);
});

// ---------- 能力健康指纹 ----------
//
// 节点每分钟重探一次本机能力，只在指纹变了的时候重发 hello。
// 这是「运行中登录态过期 / 登录回来」能被 Hub 看见的唯一途径 ——
// 在此之前 available 只在启动时上报一次，中途变化平台完全不知道。

const report = (cid: string, available: boolean, unavailableReason?: string) =>
  ({ cid, kind: "llm.chat", kindVersion: 1, provider: "p", available, unavailableReason }) as never;

test("可用性翻转时指纹必须变，否则 Hub 永远拿着过时状态", () => {
  const before = healthSignature([report("relay_claude", false, "登录态缺失"), report("relay_codex", true)]);
  const after = healthSignature([report("relay_claude", true), report("relay_codex", true)]);
  assert.notEqual(before, after, "登录回来了却判成没变，主人得重启节点才恢复");
});

test("原因变了也算变：处置建议不同，界面那句话必须跟着换", () => {
  const a = healthSignature([report("relay_claude", false, "登录态缺失")]);
  const b = healthSignature([report("relay_claude", false, "登录态已过期")]);
  assert.notEqual(a, b);
});

test("顺序不影响指纹：探测返回顺序变了不该触发一次无谓的 hello", () => {
  const a = healthSignature([report("x", true), report("y", false, "r")]);
  const b = healthSignature([report("y", false, "r"), report("x", true)]);
  assert.equal(a, b);
});

test("完全没变时指纹相同", () => {
  const rows = [report("x", true), report("y", false, "r")];
  assert.equal(healthSignature(rows), healthSignature([...rows]));
});
