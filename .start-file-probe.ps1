$m = 'C:\Users\admin\AppData\Local\Temp\start-file-probe.txt'
$parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$gpObj = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
$gp = if ($gpObj) { $gpObj.ParentProcessId } else { -1 }
$gpn = ''
if ($gpObj) { $gpn = (Get-Process -Id $gp -ErrorAction SilentlyContinue).Name }
@(
 "pid=$PID",
 "session=$((Get-Process -Id $PID).SessionId)",
 "parentPid=$parentId",
 "parentName=$($gpObj.Name)",
 "grandparentPid=$gp",
 "grandparentName=$gpn",
 "time=$((Get-Date).ToString('s'))"
) | Add-Content -LiteralPath $m -Encoding utf8
