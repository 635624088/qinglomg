@echo off
title package xjskp-sync-multi-next automation console
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0work\package-system.ps1"
set "exitCode=%ERRORLEVEL%"
echo.
pause
exit /b %exitCode%
