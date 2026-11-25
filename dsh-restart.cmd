@echo off
rem dsh-restart.cmd -- launcher for dsh-restart.ps1
rem Keeps the helper detached from the DSH process job so killing DSH
rem does not kill the helper that is doing the restart.
setlocal
set "SCRIPT=%~dp0dsh-restart.ps1"
powershell -NoProfile -Command "& [char]0" >nul 2>&1
pwsh -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression (Get-Content -LiteralPath '%SCRIPT%' -Raw)" %*
exit /b %errorlevel%
