$ErrorActionPreference = 'Continue'
$t = 'C:\Users\admin\AppData\Local\Temp'
Remove-Item -LiteralPath "$t\start-file-probe.txt" -ErrorAction SilentlyContinue
$pwsh = (Get-Command pwsh).Source
$self = 'D:\workspace\dsh-chatroom\.start-file-probe.ps1'
$argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$self)
$quoted = ($argList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
$inner = '"' + $pwsh + '" ' + $quoted
$cmdline = 'cmd.exe /c start "" /b ' + $inner
"CMDLINE=$cmdline"
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
"RET=$($r.ReturnValue) PID=$($r.ProcessId)"
Start-Sleep -Seconds 3
"---MARKER---"
if (Test-Path -LiteralPath "$t\start-file-probe.txt") { Get-Content -LiteralPath "$t\start-file-probe.txt" } else { "MISSING" }
