<#
  dsh-restart-detached.ps1
  作用：不阻塞调用方，把 dsh-restart.ps1 交给一个脱离当前进程组的隐藏进程执行。
  这样即使当前是在 DSH 内部（AI 会话、工具子进程）运行，关掉 DSH 也不会连带杀掉重启助手。
  用法（在 DSH 里让 AI 运行）：
    pwsh -NoProfile -ExecutionPolicy Bypass -File dsh-restart-detached.ps1
  可选 -DryRun 透传给 dsh-restart.ps1。
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $here 'dsh-restart.ps1'
if (-not (Test-Path -LiteralPath $target)) { throw "找不到 $target" }

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe' }

$argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File', $target)
if ($DryRun) { $argList += '-DryRun' }
if ($Force)  { $argList += '-Force' }

# 用 cmd /c start /b 让 pwsh 成为与当前进程族脱钩的独立进程
$inner  = '"' + $pwsh + '" ' + (($argList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ') + ' >> "' + (Join-Path $env:TEMP 'dsh-restart.log') + '" 2>&1'
$cmdline = 'cmd.exe /c start "" /b ' + $inner

$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
if ($r.ReturnValue -ne 0) { throw "启动重启助手失败，Win32_Process.Create 返回 $($r.ReturnValue)" }
Write-Host "已交给脱离进程组的隐藏助手执行重启（日志：$env:TEMP\dsh-restart.log）。本命令立即返回。"
