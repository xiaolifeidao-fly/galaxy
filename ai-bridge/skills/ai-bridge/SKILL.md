---
name: ai-bridge
description: 管理本机 ai-bridge 桥接服务（Node）。它用这台机器的 Claude Code / Codex 订阅登录态把 Anthropic Messages 和 OpenAI Responses 请求原样中转给上游，供本机或同事的 Claude Code / Codex 客户端使用；带 token 鉴权、scope、并发和 IP 白名单。用户说“启动/停止/查看中转服务”“给某人生成中转 token”“把 Claude Code / Codex 接到中转”“中转 401/403/502 排查”时使用。本技能不改业务代码，不替客户端执行工具。
---

# ai-bridge

桥接服务源码在本插件根目录（`${CLAUDE_PLUGIN_ROOT}`，缺失时用 `~/plugins/ai-bridge`）。所有操作先定位根目录：

```bash
BRIDGE="${CLAUDE_PLUGIN_ROOT:-$HOME/plugins/ai-bridge}"
```

CLI 入口是 `node "$BRIDGE/dist/main.js"`（没有 `dist/` 就先 `cd "$BRIDGE" && npm ci && npm run build`）。

## 它做什么、不做什么

- 做：把客户端发来的 `/v1/messages`、`/v1/messages/count_tokens`（Anthropic）和 `/v1/responses`、`/v1/chat/completions`（OpenAI）**原样**转发到上游，只替换鉴权头。请求体、SSE 字节、上游状态码和限流头都不动。
- 做：token 认证（`Authorization: Bearer` 或 `x-api-key`）、scope 授权、每 token 并发上限、来源 IP 白名单、admin 接口仅 loopback。
- 不做：不解析 messages，不执行工具，不合成 system prompt，不改模型名。工具循环全在客户端。
- 上游登录态来自**桥接所在机器**：Claude 走 `claude auth login`（macOS Keychain / `~/.claude/.credentials.json` / `CLAUDE_CODE_OAUTH_TOKEN`），Codex 走 `codex login`（`~/.codex/auth.json`，过期自动刷新）。桥接不写回 Claude 凭据。

## 安装与启动

```bash
bash "$BRIDGE/scripts/install.sh"          # 编译 + 生成配置和 admin token + 登记到 Claude/Codex + 后台启动
bash "$BRIDGE/scripts/start.sh"            # 仅后台启动（nohup + pid）
bash "$BRIDGE/scripts/stop.sh"
bash "$BRIDGE/scripts/service.sh install   # 常驻：macOS LaunchAgent / Linux systemd --user
node "$BRIDGE/dist/main.js" status         # 探测 /readyz
```

配置文件：`node "$BRIDGE/dist/main.js" config path`（默认 `~/.config/ai-bridge/config.yaml`）。改完配置要重启桥接。运行状态与日志：`~/.local/state/ai-bridge/`。

首次 `init` 会生成一个 alias=admin、scope=`*` 的 token，只打印一次；用户没保存的话让他 `token revoke --alias admin` 后重新 `token add --alias admin --scopes '*'`。

## 给调用方发 token

```bash
node "$BRIDGE/dist/main.js" token add --alias <名字> --scopes relay:anthropic,relay:openai [--concurrency 4]
node "$BRIDGE/dist/main.js" token list
node "$BRIDGE/dist/main.js" token revoke --alias <名字>
```

- scope：`relay:anthropic`（Claude 路径）、`relay:openai`（Codex 路径）、`agent`（本机 agent 模式，默认关）、`admin`、`*`。给同事发 token 时只给需要的 relay scope，不给 `admin`/`*`。
- token 明文只在生成那一刻显示，文件里只存 sha256。新 token 让运行中的桥接生效：重启，或 `curl -X POST -H "Authorization: Bearer <admin token>" http://127.0.0.1:8787/admin/tokens/reload`。
- 不要把 token 写进仓库或聊天记录；给用户看时提醒他自行保存。

## 把客户端接上来

**Claude Code**（Anthropic 协议）：

```bash
ANTHROPIC_BASE_URL=http://<桥接地址>:8787 ANTHROPIC_AUTH_TOKEN=<token> claude --model claude-sonnet-4-5
```

模型名填上游真实支持的 Claude model ID。客户端如果设了 `ANTHROPIC_API_KEY` 等覆盖项要先清掉。

**Codex CLI**（Responses 协议）：在 `~/.codex/config.toml` 加：

```toml
model_provider = "ai-bridge"

[model_providers.ai-bridge]
name = "ai-bridge"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://<桥接地址>:8787/v1"
experimental_bearer_token = "<token>"
```

改用户的 `~/.codex/config.toml` 前先给他看要加的片段并确认。

## 给别的机器用

默认 `server.host: 127.0.0.1`。要开放：把 `host` 改成 `0.0.0.0`，**同时**配 `auth.ipAllowlist`（如 `["10.0.0.0/8"]`）或确保有防火墙/安全组；`auth.enabled` 永远保持 `true`。反向代理后面打开 `server.trustProxy`。

## 排查

| 现象 | 看哪里 |
| --- | --- |
| 401 `missing_token` / `invalid_token` | 客户端没带 token 或 token 不在表里；`token list` 核对 alias，确认桥接重启过或 reload 过 |
| 403 `insufficient_scope` | token 缺对应 scope；重新发一个 |
| 403 `ip_not_allowed` / `loopback_only` | `auth.ipAllowlist` / `adminLoopbackOnly` |
| 502 `relay_auth_failed` | 桥接机的 Claude/Codex 登录态过期或没登录；在**桥接机**重新 `claude auth login` / `codex login`，Claude 无需重启桥接 |
| 429 `principal_concurrency_exceeded` | 该 token 的 `concurrency` 上限 |
| 503 `queue_full` / `queue_wait_timeout` | provider 或 global 队列满；看 `/readyz` 的 queue，调 `providers.<name>.concurrency` |
| 上游 429 / 5xx 原样返回 | 桥接不重试，看响应里的 `request-id`、`retry-after` |
| 日志 | `~/.local/state/ai-bridge/ai-bridge.log`，每条带 `requestId` 和 `alias`，不含 token |

## 扩展

新功能 = 在 `src/modules/<name>/index.ts` 实现 `BridgeModule`（`enabled` / `init` / `routes` / `start` / `stop` / `health`），在 `src/modules/index.ts` 登记；路由上用 `ctx.auth.authenticate` + `ctx.auth.requireScope(...)` 声明权限；新 scope 加到 `config/schema.ts` 的 `SCOPES`。新上游鉴权方式 = 在 `src/credentials/` 实现 `CredentialProvider` 并在 `CredentialRegistry` 注册。
