#!/usr/bin/env bash
# 把 ai-bridge 注册成用户级常驻服务，交给系统自带的 supervisor 看着：
#   macOS  → LaunchAgent（KeepAlive 挂了自动拉起，RunAtLoad 登录自启）
#   Linux  → systemd --user（Restart=always + enable-linger 开机自启）
#   Windows→ scripts/service.ps1（计划任务，登录触发 + 失败重启）
#
#   scripts/service.sh install | uninstall | restart | status
#
# 为什么一定要交给系统 supervisor，而不是 nohup：nohup 起来的进程注销或关机就没了，
# 下次开机一次心跳都不发，控制台上这台机器就是「离线」—— 而主人以为自己在贡献算力。
set -euo pipefail
plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${AI_BRIDGE_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ai-bridge}"
log_file="$runtime_dir/ai-bridge.log"
action="${1:-install}"
mkdir -p "$runtime_dir"

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "找不到 node。supervisor 起进程时不走登录 shell，必须给绝对路径。" >&2
  exit 1
fi

# 运行模式决定健康检查怎么做，所以这里必须知道它。
# pool 模式刻意不监听任何端口（P-15），拿 /healthz 去探它永远是失败 ——
# 旧版就是这么写的，于是「装好了」和「装挂了」看起来一模一样。
config_path="$(node "$plugin_root/dist/main.js" config path 2>/dev/null || echo "")"
mode="relay"
if [[ -n "$config_path" && -f "$config_path" ]] && grep -qE '^mode:[[:space:]]*pool' "$config_path"; then
  mode="pool"
fi
port="${AI_BRIDGE_PORT:-8787}"

# 透传已经设好的 AI_BRIDGE_* 变量：supervisor 起进程时环境是干净的，
# 用自定义配置路径的人不透传就会被悄悄退回默认配置。
passthrough_env() {
  for name in AI_BRIDGE_CONFIG AI_BRIDGE_CONFIG_DIR AI_BRIDGE_RUNTIME_DIR; do
    [[ -n "${!name:-}" ]] && printf '%s\t%s\n' "$name" "${!name}"
  done
  true
}

# ---------- 健康检查 ----------
#
# 只看「进程起来了」不够：崩溃循环里 supervisor 会不停拉起，任何一个瞬间看都是「在跑」。
# 所以隔几秒采两次 pid，pid 变了就是在反复重启，那和没起来一样糟，而且更难发现。
running_pid() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    launchctl print "gui/$(id -u)/$1" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}'
  else
    systemctl --user show "$1" -p MainPID --value 2>/dev/null | grep -v '^0$' || true
  fi
}

health_check() {
  local handle="$1"
  if [[ "$mode" == "relay" ]]; then
    for _ in $(seq 1 40); do
      if curl -sf "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
        echo "ai-bridge 已在 http://127.0.0.1:${port} 运行（relay 模式）"
        return 0
      fi
      sleep 0.25
    done
    echo "ai-bridge 没能起来（relay 模式，端口 ${port} 探不到）。看日志：$log_file" >&2
    return 1
  fi

  # pool 模式：没有端口可探，只能看进程稳不稳。
  local first="" second=""
  for _ in $(seq 1 20); do
    first="$(running_pid "$handle")"
    [[ -n "$first" ]] && break
    sleep 0.25
  done
  if [[ -z "$first" ]]; then
    echo "ai-bridge 没能起来（pool 模式）。看日志：$log_file" >&2
    return 1
  fi
  sleep 3
  second="$(running_pid "$handle")"
  if [[ -z "$second" ]]; then
    echo "ai-bridge 起来后又退出了。看日志：$log_file" >&2
    return 1
  fi
  if [[ "$first" != "$second" ]]; then
    echo "ai-bridge 在反复重启（pid $first → $second），多半是配置有问题。看日志：$log_file" >&2
    return 1
  fi
  # 进程稳住了不等于真的接上了 Hub。令牌被拒时它会一直活着重试（这是对的：
  # 主人可能正在控制台重新配对），但那种状态最容易被当成「装好了」而放着不管，
  # 所以这里把日志里的致命原因翻出来说清楚。
  local recent
  recent="$(tail -50 "$log_file" 2>/dev/null || true)"
  if grep -q "pool_node_token_rejected" <<<"$recent"; then
    echo "ai-bridge 在运行，但 Hub 不认这台机器的节点令牌，它接不到任何任务。" >&2
    echo "重新配对：bash $plugin_root/scripts/install.sh --pool" >&2
    return 1
  fi
  if grep -q "pool_contract_mismatch" <<<"$recent"; then
    echo "ai-bridge 在运行，但契约版本和 Hub 对不上，需要升级插件。看日志：$log_file" >&2
    return 1
  fi
  echo "ai-bridge 正在运行（pool 模式，pid $second，不监听任何端口）"
  return 0
}

# ---------- Windows ----------
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
  exec powershell.exe -ExecutionPolicy Bypass -File "$(cygpath -w "$plugin_root/scripts/service.ps1" 2>/dev/null || echo "$plugin_root/scripts/service.ps1")" -Action "$action" -PluginRoot "$(cygpath -w "$plugin_root" 2>/dev/null || echo "$plugin_root")"
fi

# ---------- macOS ----------
if [[ "$(uname -s)" == "Darwin" ]]; then
  label="com.galaxy.ai-bridge"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  domain="gui/$(id -u)"

  write_plist() {
    mkdir -p "$(dirname "$plist")"
    {
      cat <<PLIST
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
  <!-- 崩溃循环时别把 CPU 打满：launchd 默认 10 秒内不会重复拉起，写出来是为了让人知道有这回事 -->
  <key>ThrottleInterval</key><integer>10</integer>
  <!-- Interactive：不被 App Nap 降频。中转请求要及时响应，Background 会被系统throttle -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$log_file</string>
  <key>StandardErrorPath</key><string>$log_file</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key><string>$HOME</string>
PLIST
      while IFS=$'\t' read -r name value; do
        [[ -n "$name" ]] && printf '    <key>%s</key><string>%s</string>\n' "$name" "$value"
      done < <(passthrough_env)
      printf '  </dict>\n</dict></plist>\n'
    } >"$plist"
  }

  # bootout/bootstrap 是现行接口；load/unload 在新版 macOS 上会静默不生效，
  # 但老系统只认后者，所以两条都留着，前者失败才退回去。
  load_agent() {
    launchctl bootout "$domain" "$plist" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1; then
      launchctl unload "$plist" >/dev/null 2>&1 || true
      launchctl load "$plist"
    fi
    launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || true
  }

  case "$action" in
    install)  write_plist; load_agent; echo "LaunchAgent 已安装：$plist"; health_check "$label" ;;
    restart)  [[ -f "$plist" ]] || { echo "还没安装，先跑 $0 install" >&2; exit 1; }; load_agent; health_check "$label" ;;
    uninstall)
      launchctl bootout "$domain" "$plist" >/dev/null 2>&1 || launchctl unload "$plist" >/dev/null 2>&1 || true
      rm -f "$plist"; echo "LaunchAgent 已移除" ;;
    status)
      pid="$(running_pid "$label")"
      [[ -f "$plist" ]] || { echo "未安装"; exit 1; }
      [[ -n "$pid" ]] && echo "运行中（$mode 模式，pid $pid）" || { echo "已安装但没在跑。看日志：$log_file"; exit 1; } ;;
    *) echo "用法：$0 install|uninstall|restart|status" >&2; exit 2 ;;
  esac
  exit 0
fi

# ---------- Linux ----------
unit="ai-bridge.service"
unit_dir="$HOME/.config/systemd/user"
if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "systemd --user 不可用。可以用 scripts/start.sh 起后台进程，但注销或关机后不会自己回来。" >&2
  exit 1
fi

case "$action" in
  install)
    mkdir -p "$unit_dir"
    {
      cat <<UNIT
[Unit]
Description=ai-bridge (Galaxy 共享算力池节点)
After=default.target
# 崩溃循环兜底：5 分钟内连挂 5 次就不再拉，留现场给人看，别把日志刷爆
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$plugin_root
ExecStart=$node_bin $plugin_root/dist/main.js start
Restart=always
RestartSec=2
StandardOutput=append:$log_file
StandardError=append:$log_file
UNIT
      while IFS=$'\t' read -r name value; do
        [[ -n "$name" ]] && printf 'Environment=%s=%s\n' "$name" "$value"
      done < <(passthrough_env)
      printf '\n[Install]\nWantedBy=default.target\n'
    } >"$unit_dir/$unit"
    systemctl --user daemon-reload
    # 没权限开 linger 不算失败，只是少了「关机后开机自启」，下次登录仍会拉起来。
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
    systemctl --user enable "$unit" >/dev/null 2>&1 || true
    systemctl --user restart "$unit"
    echo "systemd user unit 已安装：$unit_dir/$unit"
    health_check "$unit" ;;
  restart) systemctl --user restart "$unit"; health_check "$unit" ;;
  uninstall)
    systemctl --user disable --now "$unit" 2>/dev/null || true
    rm -f "$unit_dir/$unit"; systemctl --user daemon-reload; echo "unit 已移除" ;;
  status)
    systemctl --user is-active --quiet "$unit" \
      && echo "运行中（$mode 模式，pid $(running_pid "$unit")）" \
      || { echo "没在跑。看日志：$log_file"; exit 1; } ;;
  *) echo "用法：$0 install|uninstall|restart|status" >&2; exit 2 ;;
esac
