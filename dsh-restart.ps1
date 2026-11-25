<#
  dsh-restart.ps1 —— 重启 DeepSeek Harness 桌面版
  用法：
    pwsh -NoProfile -ExecutionPolicy Bypass -File dsh-restart.ps1
    pwsh -NoProfile -ExecutionPolicy Bypass -File dsh-restart.ps1 -Force -Wait
  流程：结束所有 DeepSeek Harness 进程 -> 等待退出 -> 重新启动 -> 校验存活。
  脱离 DSH 进程组启动，可在 DSH 内部（含 AI 会话里）运行。
#>
[CmdletBinding()]
param(
  # 不结束进程，只打印将要操作的对象（排错用）。
  [switch]$DryRun,
  # 跳过正常关闭，直接强制结束。
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$AppExe    = 'D:\software\deepseek HARNESS\DeepSeek Harness.exe'
$ProcName  = 'DeepSeek Harness'
$KillTimeoutSec = 20   # 正常关闭的等待上限
$StartWaitSec   = 40   # 等待画面进程起来的时长

function Write-Step([string]$msg) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg)
}

function Get-DshProcesses {
  @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)
}

function Get-DshRoots {
  # 根进程 = 父进程不是 DSH 的那些（主进程、以及被其它非 DSH 拉起的宿主）
  $all = @(Get-CimInstance Win32_Process -Filter "Name='$ProcName.exe'" -ErrorAction SilentlyContinue)
  $ids = @($all | ForEach-Object { $_.ProcessId })
  @($all | Where-Object { $ids -notcontains $_.ParentProcessId })
}

if ($DryRun) {
  Write-Step "DRY-RUN：以下为当前 DSH 进程"
  Get-CimInstance Win32_Process -Filter "Name='$ProcName.exe'" |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath |
    Format-Table -AutoSize | Out-String | Write-Host
  Write-Step "目标可执行文件：$AppExe"
  return
}

# ---------- 1. 结束进程 ----------
$procs = Get-DshProcesses
if ($procs.Count -eq 0) {
  Write-Step "未发现运行中的 $ProcName，直接启动。"
} else {
  Write-Step ("发现 {0} 个 {1} 进程，开始关闭。" -f $procs.Count, $ProcName)

  if (-not $Force) {
    # 先请求根进程正常退出（会连带关掉子进程），给它一点时间
    $roots = Get-DshRoots
    foreach ($r in $roots) {
      $p = Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue
      if ($p) {
        try { [void]$p.CloseMainWindow() } catch { }
      }
    }
    $deadline = (Get-Date).AddSeconds($KillTimeoutSec)
    while ((Get-Date) -lt $deadline) {
      if ((Get-DshProcesses).Count -eq 0) { break }
      Start-Sleep -Milliseconds 400
    }
  }

  # 仍存活则强制结束全部 DSH 进程（含子进程）
  $left = Get-DshProcesses
  if ($left.Count -gt 0) {
    Write-Step ("强制结束剩余 {0} 个进程。" -f $left.Count)
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
  }

  # 确认全部退出
  $deadline = (Get-Date).AddSeconds($KillTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ((Get-DshProcesses).Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
  }
  $still = Get-DshProcesses
  if ($still.Count -gt 0) {
    throw ("仍有 {0} 个 {1} 进程未能结束：{2}" -f $still.Count, $ProcName, (($still | ForEach-Object { $_.Id }) -join ','))
  }
  Write-Step "进程已全部退出。"
}

# ---------- 2. 重新启动 ----------
if (-not (Test-Path -LiteralPath $AppExe)) {
  throw "找不到 DeepSeek Harness 可执行文件：$AppExe"
}

Write-Step "启动 $AppExe"
Start-Process -FilePath $AppExe -WorkingDirectory (Split-Path -Parent $AppExe)

# ---------- 3. 校验存活 ----------
$deadline = (Get-Date).AddSeconds($StartWaitSec)
$ok = $false
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p) { $ok = $true; break }
  Start-Sleep -Milliseconds 500
}

if ($ok) {
  $first = Get-CimInstance Win32_Process -Filter "Name='$ProcName.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
  Write-Step ("已启动，主进程 PID={0}，共 {1} 个进程。" -f $first.ProcessId, (Get-DshProcesses).Count)
} else {
  throw "启动后未检测到 $ProcName 进程，请检查程序是否需要以管理员身份运行或路径是否变化。"
}
