<#
  dsh-restart.ps1 —— 重启 DeepSeek Harness 桌面版（结束进程后重新启动）

  用途：开发插件时改了代码需要重启 DSH 才能生效；本脚本一键杀掉旧进程再启动，
        也可以让 AI 直接在会话里运行。

  用法：
    pwsh -NoProfile -ExecutionPolicy Bypass -File dsh-restart.ps1           # 正常重启
    pwsh -NoProfile -ExecutionPolicy Bypass -File dsh-restart.ps1 -DryRun   # 只列进程，不改动
    pwsh -NoProfile -ExecutionPolicy Bypass -File dsh-restart.ps1 -Force    # 直接强制结束

  本机安装路径配置（脚本本身不含任何机器路径，可直接共享）：
    1) 同目录下 dsh-restart.local.ps1（已被 .gitignore 忽略，不入仓），参考 dsh-restart.local.example.ps1
    2) 环境变量 DSH_APP_EXE，指向 DeepSeek Harness.exe 的完整路径（优先级高于配置文件）
    两者都没有时才报错并提示如何配置。

  说明：脚本会把自己重新拉起成一个“脱离 DSH 进程组”的隐藏助手来执行重启，
        因此在 DSH 内部（包括 AI 会话、工具子进程）运行也能完成重启——
        即使结束 DSH 会连带杀掉当前会话，重启助手仍会继续把 DSH 重新启动。
  日志：%TEMP%\dsh-restart.log
#>
[CmdletBinding()]
param(
  [switch]$Worker,      # 内部使用：真正的重启执行者，由脚本自身以脱离进程组方式拉起
  [switch]$DryRun,      # 只列出解析结果和进程，不结束、不启动
  [switch]$Force,       # 跳过正常关闭，直接强制结束
  [string]$AppExe,      # 内部使用：入口解析后传给 Worker 的可执行文件路径
  [string]$ProcName     # 内部使用：进程名
)

$ErrorActionPreference = 'Stop'
try {
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

$HelperNames    = @('dsh-tailcat-host')
$GracefulSec    = 5
$KillTimeoutSec = 20
$StartWaitSec   = 45
$LogPath        = Join-Path $env:TEMP 'dsh-restart.log'
$LocalConfig    = Join-Path $ScriptDir 'dsh-restart.local.ps1'

$script:IsWorker = [bool]$Worker

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  if ($script:IsWorker) {
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8 } catch { }
  } else {
    Write-Host $line
  }
}

# 解析本机安装路径：显式参数 > 环境变量 DSH_APP_EXE > 本地配置文件 > 无
function Resolve-DshConfig {
  param([string]$ExeOverride, [string]$NameOverride)

  $resolvedExe  = $null
  $resolvedName = $null
  $source       = '未配置'

  $DshAppExe = $null
  $DshProcName = $null
  if (Test-Path -LiteralPath $LocalConfig) {
    . $LocalConfig
    if ($DshAppExe)  { $resolvedExe  = $DshAppExe;  $source = 'dsh-restart.local.ps1' }
    if ($DshProcName) { $resolvedName = $DshProcName }
  }

  if ($env:DSH_APP_EXE) { $resolvedExe = $env:DSH_APP_EXE; $source = '环境变量 DSH_APP_EXE' }
  if ($ExeOverride)     { $resolvedExe = $ExeOverride;     $source = '调用参数' }

  if (-not $resolvedName) { $resolvedName = 'DeepSeek Harness' }
  if ($NameOverride)      { $resolvedName = $NameOverride }

  [pscustomobject]@{
    AppExe  = $resolvedExe
    ProcName = $resolvedName
    Source  = $source
  }
}

$script:Cfg      = Resolve-DshConfig -ExeOverride $AppExe -NameOverride $ProcName
$script:ProcName = $script:Cfg.ProcName
$script:AppExe   = $script:Cfg.AppExe

function Get-DshProcesses {
  @(Get-Process -Name $script:ProcName -ErrorAction SilentlyContinue)
}

function Get-DshRoots {
  $all = @(Get-CimInstance Win32_Process -Filter "Name='$($script:ProcName).exe'" -ErrorAction SilentlyContinue)
  $ids = @($all | ForEach-Object { $_.ProcessId })
  @($all | Where-Object { $ids -notcontains $_.ParentProcessId })
}

# ---------- DryRun：只查看 ----------
if ($DryRun) {
  Write-Log 'DRY-RUN：不会做任何改动'
  Write-Log ("已解析可执行文件（来源：{0}）：{1}" -f $script:Cfg.Source, ($(if ($script:AppExe) { $script:AppExe } else { '<未配置>' })))
  Write-Log ("进程名：{0}" -f $script:ProcName)
  Write-Log "日志文件：$LogPath"
  Write-Log '当前 DSH 进程如下：'
  Get-CimInstance Win32_Process -Filter "Name='$($script:ProcName).exe'" |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath |
    Format-Table -AutoSize | Out-String | Write-Host
  return
}

# ---------- 入口：把自己以脱离 DSH 进程组的方式重新拉起 ----------
if (-not $Worker) {
  if (-not $script:AppExe) {
    Write-Log ("未配置本机安装路径。请二选一：" )
    Write-Log ("  1) 复制 dsh-restart.local.example.ps1 为 dsh-restart.local.ps1 并填写 $DshAppExe")
    Write-Log ("  2) 设置环境变量 DSH_APP_EXE 为 DeepSeek Harness.exe 的完整路径")
    throw "缺少 DSH 安装路径配置。"
  }

  $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if (-not $pwsh) { $pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe' }
  if (-not (Test-Path -LiteralPath $pwsh)) { throw "找不到 pwsh：$pwsh" }

  $self = $PSCommandPath
  if (-not $self) { $self = Join-Path $ScriptDir 'dsh-restart.ps1' }
  $argList = @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File', $self, '-Worker', '-AppExe', $script:AppExe, '-ProcName', $script:ProcName)
  if ($Force) { $argList += '-Force' }
  $quoted  = ($argList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $inner   = '"' + $pwsh + '" ' + $quoted
  $cmdline = 'cmd.exe /c start "" /b ' + $inner

  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
  if ($r.ReturnValue -ne 0) { throw "启动重启助手失败（Win32_Process.Create 返回 $($r.ReturnValue)）" }

  Write-Log '已交给脱离 DSH 进程组的隐藏助手执行重启，本命令立即返回。'
  Write-Log "重启日志：$LogPath"
  return
}

# ---------- Worker：真正的重启 ----------
try {
  Write-Log '===== 开始重启 ====='
  Write-Log ("可执行文件：{0}" -f $script:AppExe)

  $procs = Get-DshProcesses
  if ($procs.Count -eq 0) {
    Write-Log "未发现运行中的 $($script:ProcName)，直接启动。"
  } else {
    Write-Log ("发现 {0} 个 {1} 进程，开始关闭。" -f $procs.Count, $script:ProcName)

    if (-not $Force) {
      foreach ($root in (Get-DshRoots)) {
        $p = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
        if ($p) { try { [void]$p.CloseMainWindow() } catch { } }
      }
      $deadline = (Get-Date).AddSeconds($GracefulSec)
      while ((Get-Date) -lt $deadline) {
        if ((Get-DshProcesses).Count -eq 0) { break }
        Start-Sleep -Milliseconds 400
      }
    }

    $left = Get-DshProcesses
    if ($left.Count -gt 0) {
      Write-Log ("强制结束剩余 {0} 个进程。" -f $left.Count)
      $left | Stop-Process -Force -ErrorAction SilentlyContinue
    }

    $deadline = (Get-Date).AddSeconds($KillTimeoutSec)
    while ((Get-Date) -lt $deadline) {
      if ((Get-DshProcesses).Count -eq 0) { break }
      Start-Sleep -Milliseconds 300
    }
    $still = Get-DshProcesses
    if ($still.Count -gt 0) {
      throw ("仍有 {0} 个 {1} 进程未能结束：{2}" -f $still.Count, $script:ProcName, (($still | ForEach-Object { $_.Id }) -join ','))
    }
    Write-Log 'DSH 进程已全部退出。'
  }

  foreach ($hn in $HelperNames) {
    $hp = @(Get-Process -Name $hn -ErrorAction SilentlyContinue)
    if ($hp.Count -gt 0) {
      Write-Log ("结束辅助进程 {0}（{1} 个）。" -f $hn, $hp.Count)
      $hp | Stop-Process -Force -ErrorAction SilentlyContinue
    }
  }

  Start-Sleep -Milliseconds 800

  if (-not (Test-Path -LiteralPath $script:AppExe)) { throw "找不到可执行文件：$($script:AppExe)" }
  Write-Log "启动 $($script:AppExe)"
  Start-Process -FilePath $script:AppExe -WorkingDirectory (Split-Path -Parent $script:AppExe) -WindowStyle Normal

  $deadline = (Get-Date).AddSeconds($StartWaitSec)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    if (Get-Process -Name $script:ProcName -ErrorAction SilentlyContinue) { $ok = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if ($ok) {
    $first = Get-CimInstance Win32_Process -Filter "Name='$($script:ProcName).exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
    Write-Log ("启动成功，主进程 PID={0}，当前 {1} 个进程。" -f $first.ProcessId, (Get-DshProcesses).Count)
    Write-Log '===== 重启完成 ====='
  } else {
    throw "启动后未检测到 $($script:ProcName) 进程，请人工检查。"
  }
} catch {
  Write-Log ("重启失败：" + $_.Exception.Message)
  exit 1
}
