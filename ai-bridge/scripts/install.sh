#!/usr/bin/env bash
# 一键安装：编译 → 生成配置/admin token → 登记到 Claude Code 与 Codex → 后台启动。
#   scripts/install.sh            装 Claude + Codex（有哪个装哪个）
#   scripts/install.sh --claude   只装 Claude Code
#   scripts/install.sh --codex    只装 Codex
#   scripts/install.sh --pool     贡献算力：编译 + init，然后打开配置向导
#
# --pool 是给「把本机算力共享出去」的人用的，和上面三个是两条路：
# 它不登记 Claude/Codex 插件，也不启动 relay —— 那会在本机开一个 8787 端口，
# 而贡献者要的是 pool 模式：除了一个本机配置接口（回环 39217），全是出站连接。
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

# supervise 把节点交给系统自带的 supervisor（launchd / systemd --user / 计划任务）。
# 装不上就退回 nohup，并且说清楚代价 —— 装不上不该让整条安装流程失败。
supervise() {
  if bash "$plugin_root/scripts/service.sh" install; then
    return 0
  fi
  echo "交给系统托管失败，改用后台进程：注销或关机后需要手工再起一次。" >&2
  bash "$plugin_root/scripts/start.sh"
}

if [[ $pool_mode == 1 ]]; then
  echo
  echo "接下来在浏览器里完成配对。"
  # 不再 exec：配对完还得把节点常驻起来，exec 掉这个 shell 就没人干这件事了。
  # 以前这里 exec，于是贡献者配对完什么都没启动，控制台上永远是「离线」。
  node dist/main.js pool setup

  # 配对成功才装服务。向导 15 分钟无操作也会自己退，那时候还没配对，
  # 装一个连不上 Hub 的常驻进程只会在日志里刷错误。
  # 用 pool status 判断而不是猜 node-token.json 的路径 —— tokenFile 是可配的。
  if node dist/main.js pool status >/dev/null 2>&1; then
    echo
    echo "配对完成，把节点交给系统托管（挂了自动拉起、登录自启）……"
    supervise
  else
    echo
    echo "还没配对完。配对之后跑这条把节点常驻起来："
    echo "  bash $plugin_root/scripts/service.sh install"
  fi
  exit 0
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

supervise
echo
echo "下一步：用 \`ai-bridge token add --alias <名字>\` 给每个调用方发 token；"
echo "Claude Code 侧：ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=<token> claude"
echo "Codex 侧：在 ~/.codex/config.toml 加 model_providers（见 skills/ai-bridge/SKILL.md）"
