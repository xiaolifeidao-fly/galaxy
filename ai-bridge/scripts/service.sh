#!/usr/bin/env bash
# 把桥接注册成用户级常驻服务：macOS LaunchAgent / Linux systemd --user。
#   scripts/service.sh install | uninstall | restart
set -euo pipefail
plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${AI_BRIDGE_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ai-bridge}"
log_file="$runtime_dir/ai-bridge.log"
node_bin="$(command -v node)"
action="${1:-install}"
mkdir -p "$runtime_dir"

if [[ "$(uname -s)" == "Darwin" ]]; then
  label="com.galaxy.ai-bridge"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  case "$action" in
    install)
      mkdir -p "$(dirname "$plist")"
      cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>$node_bin</string><string>$plugin_root/dist/main.js</string><string>start</string>
  </array>
  <key>WorkingDirectory</key><string>$plugin_root</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log_file</string>
  <key>StandardErrorPath</key><string>$log_file</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
</dict></plist>
PLIST
      launchctl unload "$plist" 2>/dev/null || true
      launchctl load "$plist"
      echo "LaunchAgent installed: $plist" ;;
    uninstall)
      launchctl unload "$plist" 2>/dev/null || true
      rm -f "$plist"; echo "LaunchAgent removed" ;;
    restart)
      launchctl unload "$plist" 2>/dev/null || true; launchctl load "$plist"; echo "restarted" ;;
    *) echo "usage: $0 install|uninstall|restart" >&2; exit 2 ;;
  esac
else
  unit="ai-bridge.service"
  unit_dir="$HOME/.config/systemd/user"
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
    echo "systemd --user 不可用；用 scripts/start.sh 起后台进程即可" >&2; exit 1
  fi
  case "$action" in
    install)
      mkdir -p "$unit_dir"
      cat >"$unit_dir/$unit" <<UNIT
[Unit]
Description=ai-bridge local relay
After=default.target

[Service]
Type=simple
WorkingDirectory=$plugin_root
ExecStart=$node_bin $plugin_root/dist/main.js start
Restart=always
RestartSec=2
StandardOutput=append:$log_file
StandardError=append:$log_file

[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload
      loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
      systemctl --user enable "$unit" >/dev/null 2>&1 || true
      systemctl --user restart "$unit"
      echo "systemd user unit installed: $unit_dir/$unit" ;;
    uninstall)
      systemctl --user disable --now "$unit" 2>/dev/null || true
      rm -f "$unit_dir/$unit"; systemctl --user daemon-reload; echo "unit removed" ;;
    restart) systemctl --user restart "$unit"; echo "restarted" ;;
    *) echo "usage: $0 install|uninstall|restart" >&2; exit 2 ;;
  esac
fi
