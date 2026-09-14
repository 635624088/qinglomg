@echo off
title stop xjskp automation console
setlocal
set "BASE_DIR=%~dp0"
set "PORTABLE_MARKER=%BASE_DIR%PORTABLE-RUNTIME.txt"
if exist "%PORTABLE_MARKER%" goto runLocal

set "RELEASE_CMD=%BASE_DIR%release\xjskp-sync-multi-next\stop-system.cmd"
if not exist "%RELEASE_CMD%" goto packageMissing
echo Redirecting to portable package:
echo %RELEASE_CMD%
call "%RELEASE_CMD%" %*
exit /b %ERRORLEVEL%

:packageMissing
echo Portable package not found:
echo %BASE_DIR%release\xjskp-sync-multi-next
echo Nothing was stopped from the portable package.
echo.
if defined XJSKP_NO_PAUSE exit /b 1
pause
exit /b 1

:runLocal
cd /d "%BASE_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%work\stop-system.ps1"
set "exitCode=%ERRORLEVEL%"
echo.
if defined XJSKP_NO_PAUSE exit /b %exitCode%
pause
exit /b %exitCode%
