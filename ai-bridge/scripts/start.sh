#!/usr/bin/env bash
# 后台启动桥接（nohup + pid 文件）。想开机自启用 scripts/service.sh install。
set -euo pipefail
plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${AI_BRIDGE_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ai-bridge}"
pid_file="$runtime_dir/ai-bridge.pid"
log_file="$runtime_dir/ai-bridge.log"
port="${AI_BRIDGE_PORT:-8787}"

mkdir -p "$runtime_dir"
cd "$plugin_root"

if [[ ! -d node_modules ]]; then npm ci --omit=dev --no-audit --no-fund; fi
if [[ ! -f dist/main.js ]]; then npm run build; fi
if [[ ! -f "$(node dist/main.js config path)" ]]; then node dist/main.js init; fi

if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  echo "ai-bridge already running, pid $(cat "$pid_file")"
  exit 0
fi

nohup node dist/main.js start >>"$log_file" 2>&1 &
echo $! >"$pid_file"

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
    echo "ai-bridge is running at http://127.0.0.1:${port} (pid $(cat "$pid_file"), log $log_file)"
    exit 0
  fi
  sleep 0.2
done
echo "ai-bridge failed to start, see $log_file" >&2
exit 1
