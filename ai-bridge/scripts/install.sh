#!/usr/bin/env bash
# 一键安装：编译 → 生成配置/admin token → 登记到 Claude Code 与 Codex → 后台启动。
#   scripts/install.sh            装 Claude + Codex（有哪个装哪个）
#   scripts/install.sh --claude   只装 Claude Code
#   scripts/install.sh --codex    只装 Codex
#   scripts/install.sh --pool     贡献算力：编译 + init，然后打开配置向导
#
# --pool 是给「把本机算力共享出去」的人用的，和上面三个是两条路：
# 它不登记 Claude/Codex 插件，也不启动 relay —— 那会在本机开一个 8787 端口，
# 而贡献者要的是 pool 模式（不监听任何端口，只有出站连接）。
set -euo pipefail
plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
galaxy_root="$(cd "$plugin_root/.." && pwd)"
want_claude=1; want_codex=1; pool_mode=0
for a in "$@"; do
  case "$a" in
    --claude) want_codex=0 ;;
    --codex) want_claude=0 ;;
    --pool) pool_mode=1 ;;
  esac
done

cd "$plugin_root"
command -v node >/dev/null || { echo "需要 Node.js >= 20" >&2; exit 1; }
npm ci --no-audit --no-fund
npm run build
# init 已经跑过就跳过：它会重新生成 admin token，覆盖掉用户已经发出去的那把。
if [[ -f "$(node dist/main.js config path 2>/dev/null || true)" ]]; then
  echo "配置已存在，跳过 init"
else
  node dist/main.js init
fi

if [[ $pool_mode == 1 ]]; then
  echo
  echo "接下来在浏览器里配对并勾选要共享的能力。"
  exec node dist/main.js pool setup
fi

if [[ $want_claude == 1 ]] && command -v claude >/dev/null 2>&1; then
  # galaxy 根目录就是 marketplace（.claude-plugin/marketplace.json）
  claude plugin marketplace add "$galaxy_root" 2>/dev/null || claude plugin marketplace update galaxy 2>/dev/null || true
  claude plugin install ai-bridge@galaxy || echo "claude plugin install 失败，可手动执行：claude plugin install ai-bridge@galaxy" >&2
fi

if [[ $want_codex == 1 ]] && command -v codex >/dev/null 2>&1; then
  install_root="$HOME/plugins/ai-bridge"
  mkdir -p "$install_root"
  rsync -a --delete --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' "$plugin_root/" "$install_root/"
  node "$plugin_root/scripts/register-codex.mjs"
  codex plugin add ai-bridge@personal || echo "codex plugin add 失败，可手动执行：codex plugin add ai-bridge@personal" >&2
fi

bash "$plugin_root/scripts/start.sh"
echo
echo "下一步：用 \`ai-bridge token add --alias <名字>\` 给每个调用方发 token；"
echo "Claude Code 侧：ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=<token> claude"
echo "Codex 侧：在 ~/.codex/config.toml 加 model_providers（见 skills/ai-bridge/SKILL.md）"
