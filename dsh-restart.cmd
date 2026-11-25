@echo off
rem dsh-restart.cmd - double-click / cmd entry for dsh-restart.ps1
rem The ps1 re-launches itself detached from the DSH process job, so this works
rem both from an external terminal and from inside DSH.
setlocal
set "SCRIPT=%~dp0dsh-restart.ps1"
pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %errorlevel%
