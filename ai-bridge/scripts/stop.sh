#!/usr/bin/env bash
set -euo pipefail
runtime_dir="${AI_BRIDGE_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ai-bridge}"
pid_file="$runtime_dir/ai-bridge.pid"
if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  kill "$(cat "$pid_file")"
  echo "ai-bridge stopped (pid $(cat "$pid_file"))"
else
  echo "ai-bridge is not running"
fi
rm -f "$pid_file"
