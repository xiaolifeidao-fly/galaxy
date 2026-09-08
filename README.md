# galaxy

插件仓库，同时是 Claude Code 插件市场（`.claude-plugin/marketplace.json`）。每个插件占一个子目录。

| 插件 | 说明 |
| --- | --- |
| [`ai-bridge/`](ai-bridge/) | 本机 Node 桥接服务：用 Claude / Codex 订阅登录态中转 Anthropic Messages 与 OpenAI Responses，带 token 鉴权、scope 与可扩展模块 |

## 安装

```bash
claude plugin marketplace add /path/to/galaxy
claude plugin install ai-bridge@galaxy
```

Codex：`bash ai-bridge/scripts/install.sh --codex`（同步到 `~/plugins/ai-bridge` 并登记到个人市场）。

作为 submodule 挂在 `universe` 项目的 `galaxy/` 下。
