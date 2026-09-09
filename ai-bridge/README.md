# ai-bridge

本机桥接服务（Node ≥ 20 / TypeScript）。用这台机器的 Claude Code / Codex 订阅登录态，把 Anthropic Messages 与 OpenAI Responses 请求原样中转给上游。以 Claude Code / Codex 插件形式分发，`skills/ai-bridge` 教 agent 怎么装、怎么发 token、怎么接客户端。

两种模式，互斥：

| `mode` | 谁在用 | 网络形态 |
| --- | --- | --- |
| `relay`（默认） | 本机或同事的客户端 | 监听 `127.0.0.1:8787`，靠 token + IP 白名单放行 |
| `pool` | Galaxy 共享算力池的消费者 | **不监听任何端口**，只主动出站连 Hub |

从 `ai-sdk-client` 迁移而来；中转链路、凭据读取、并发闸门、超时与断流语义保持一致，鉴权和结构重做。

## 结构

```
src/
├── main.ts            CLI：start / init / status / token add|list|revoke / config path
├── app.ts             装配：config → auth → gate → modules → express
├── config/            zod schema + yaml 加载 + 一致性校验
├── auth/              principal / token 存储（sha256 + timingSafeEqual）/ IP 白名单 / 中间件
├── credentials/       上游凭据：claude_oauth / codex_chatgpt / api_key（CredentialProvider）
├── core/              logger / errors / paths / queue（三层闸门）/ retry / proxy（透传）/ request 生命周期
├── modules/           BridgeModule 清单
│   ├── health/        /healthz /readyz（无鉴权）
│   ├── relay/         /v1/messages* /v1/responses /v1/chat/completions 透传
│   ├── admin/         /admin/status /admin/tokens*（loopback + admin scope）
│   ├── agent/         本机 Claude Code / Codex agent 模式（默认关）：adapters + 协议转换
│   └── pool/          共享算力池节点：Hub 客户端 / 运行循环 / 通道闸门 / 能力探测 / 节点令牌
└── business/          共享池的契约与节点 provider（按 kind 分目录）
    ├── core/          WorkUnit / Payload / Metering 类型与工具
    ├── llm-chat/      中转：kind.yaml + JSON Schema + node/relay-provider.ts
    ├── delivery-task/ agent 回合：node/planner-bridge.ts（stdin JSON → stdout NDJSON）
    └── video-edit/    本机渲染：node/ffmpeg-local.ts（OSS 直取直传）
```

`business/` 按设计文档本该放在仓库根的 `galaxy/business/`；放进插件目录是因为
ai-bridge 是整目录分发的（安装脚本只同步 `ai-bridge/`），依赖兄弟目录会装出一个
跑不起来的插件。目录内部结构与设计文档一致。

## 访问控制

| 层 | 配置 | 说明 |
| --- | --- | --- |
| 监听地址 | `server.host` | 默认 `127.0.0.1` |
| 来源 IP | `auth.ipAllowlist` | CIDR 白名单，空 = 不限 |
| 认证 | `auth.tokens` / `tokenFile` | `Authorization: Bearer` 或 `x-api-key`；进程内只留 sha256 |
| 授权 | token 的 `scopes` | `relay:anthropic` `relay:openai` `agent` `admin` `*` |
| 配额 | token 的 `concurrency` | 单个调用方并发上限，超了 429 |
| admin | `auth.adminLoopbackOnly` | `/admin/*` 只允许本机 |

日志只记 alias / requestId，不记 token 与凭据。

## 开发

```bash
npm ci
npm run typecheck
npm test          # 只连本地模拟上游，不读真实登录态
npm run build
node dist/main.js init && node dist/main.js start
```

## 端点

| 路径 | 模块 | scope |
| --- | --- | --- |
| `GET /healthz` `GET /readyz` | health | 无 |
| `POST /v1/messages` `POST /v1/messages/count_tokens` | relay | `relay:anthropic` |
| `POST /v1/responses` `POST /v1/chat/completions` | relay | `relay:openai` |
| 同上 + 请求头 `x-ai-agent: 1` | agent | `agent` |
| `GET /admin/status` `GET/POST /admin/tokens` `DELETE /admin/tokens/:alias` `POST /admin/tokens/reload` | admin | `admin` |

## 共享算力池（pool 模式）

把这台机器闲置的订阅额度贡献给共享池，由平台调度给别的用户按量使用；设计见
[`doc/galaxy/`](../../doc/galaxy/README.md)。

```bash
node dist/main.js pool probe          # 本机有什么能力（只列出，不申报）
node dist/main.js pool pair <配对码>  # 用一次性配对码换长期节点令牌
node dist/main.js pool status         # 本地节点状态与已配置的贡献
node dist/main.js start               # mode=pool 时加入共享池
```

能贡献三类能力，各自的边界很不一样：

| kind | 干什么 | 在你机器上发生什么 |
| --- | --- | --- |
| `llm.chat` | 用你的 Claude / Codex 订阅转发请求 | 只有一次出站 HTTPS，不碰文件系统 |
| `delivery.task` | 跑一个 agent 回合 | **跑命令、写文件**。跑什么完全由你在 `exec` 里写的命令决定 |
| `video.edit.render` | 本机 ffmpeg 渲染 | 下载素材 → 渲染 → 上传产物，全在一个临时目录里，单元结束即删 |

几条边界，配之前先看清楚：

- **探测 ≠ 贡献。** `pool probe` 只告诉你本机有什么，共享哪几种、共享多少，
  由 `pool.contributions` 里你自己写的那几行决定。没写的能力 Hub 看不到。
- **不监听端口。** pool 模式下 `server.*`、`auth.*`、`relay.*`、`admin.*` 全部不生效，
  进程只有出站连接，攻击面就是「主动连了谁」。
- **三维额度同时生效。** token、时长、次数任一触顶就停止接新单，在跑的跑完。
  额度以 Hub 为权威，本地配置只是申报值；主人在控制台改了以 Hub 为准。
- **凭据不出本机。** 上游订阅登录态只在这台机器读取，Hub 与消费者永远拿不到。
- **上游跟着本机正在用的走。** provider 不写 `baseURL` 时，Claude 按 managed-settings /
  `~/.claude/settings.json` / 环境变量里的 `ANTHROPIC_BASE_URL`，Codex 按 `~/.codex/config.toml`
  的 `model_provider` → `base_url`（或 `chatgpt_base_url`）决定打哪：本机接了中转站就打中转站
  （令牌也取同处），没接就打订阅官方。写了 `baseURL` 则以它为准。每次请求重新读，改完不用重启。
- **不留消费者内容。** 每个工作单元一个临时目录，单元结束后整个删掉；
  日志只记 requestId 与贡献 id。
- **Hub 会抽检。** 每个贡献每天不超过 1% 的请求会被平台用自己的账号重放一次，
  比对响应的结构（事件类型，不是内容）。这是为了识别「不调上游、直接编响应」的节点；
  诚实跑的机器不会受影响。
- **消费者对你是匿名的。** 节点只看得到 `ck_…` 这个匿名标识；日志只记
  requestId 与贡献 id，不记请求内容。
- **节点令牌明文存在 `~/.local/state/ai-bridge/node-token.json`（权限 0600）。**
  它必须能在重启后原样出示给 Hub，存哈希等于每次重启都要重新配对。

## 已知边界

- Claude 订阅 OAuth 的使用受 Anthropic 产品条款约束，HTTP 转发不保证订阅账号一定被上游接受；桥接不合成 Claude Code 身份，只透传真实客户端请求。
- relay 不自动重试上游 429/5xx，原样交给客户端处理。
- agent 模块的跨协议转换不等于原始 API 透传，工具在桥接机执行。
- pool 模式把个人订阅席位按量共享出去，属于账号共享，被封的是**你的**账号；
  加入前控制台会要求明示同意，合规替代形态是 BYOK / 商用 API 组池。
