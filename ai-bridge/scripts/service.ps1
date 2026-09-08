# 把 ai-bridge 注册成 Windows 计划任务：登录时触发，失败自动重启。
#   powershell -ExecutionPolicy Bypass -File scripts\service.ps1 -Action install
#
# Windows 上没有 systemd/launchd 这种用户级 supervisor，计划任务是不需要管理员
# 权限、又能做到「登录自启 + 挂了拉起」的唯一一条路。注意它不是 Windows 服务：
# 服务要装在 SYSTEM 下，那样就读不到用户自己的 AI 订阅登录态了 —— 而那正是要中转的东西。
param(
  [ValidateSet("install", "uninstall", "restart", "status")]
  [string]$Action = "install",
  [string]$PluginRoot = ""
)

$ErrorActionPreference = "Stop"
$taskName = "Galaxy ai-bridge"

if (-not $PluginRoot) {
  $PluginRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
$mainScript = Join-Path $PluginRoot "dist\main.js"

function Get-NodeCommand {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "找不到 node。需要 Node.js 20 或更高版本。" }
  return $node.Source
}

switch ($Action) {
  "install" {
    if (-not (Test-Path -LiteralPath $mainScript)) {
      throw "还没编译：$mainScript 不存在。先在插件目录里跑 npm ci; npm run build"
    }
    $nodePath = Get-NodeCommand
    $runtimeDir = Join-Path $env:USERPROFILE ".local\state\ai-bridge"
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    # LogonType InteractiveToken + RunLevel Limited：跑在用户自己的会话里，
    # 才读得到 Claude / Codex 的登录态。提权反而会读不到。
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType InteractiveToken -RunLevel Limited
    $action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"' + $mainScript + '" start') -WorkingDirectory $PluginRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
      -RestartCount 10 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -MultipleInstances IgnoreNew `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -StartWhenAvailable `
      -DontStopIfGoingOnBatteries `
      -AllowStartIfOnBatteries
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
      -Settings $settings -Description "Galaxy 共享算力池的本机节点。" -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Host "计划任务已安装并启动：$taskName"
  }
  "uninstall" {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "计划任务已移除：$taskName"
  }
  "restart" {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $taskName
    Write-Host "已重启：$taskName"
  }
  "status" {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host "未安装"; exit 1 }
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    Write-Host ("状态：" + $task.State + "，上次运行结果：" + $info.LastTaskResult)
    if ($task.State -ne "Running") { exit 1 }
  }
}
