@echo off
title xjskp
setlocal
set "BASE_DIR=%~dp0"
set "PORTABLE_MARKER=%BASE_DIR%PORTABLE-RUNTIME.txt"
if exist "%PORTABLE_MARKER%" goto runLocal

set "RELEASE_CMD=%BASE_DIR%release\xjskp-sync-multi-next\run-auto-plant.cmd"
if not exist "%RELEASE_CMD%" goto packageMissing
echo Redirecting to portable package:
echo %RELEASE_CMD%
call "%RELEASE_CMD%" %*
exit /b %ERRORLEVEL%

:packageMissing
echo Portable package not found:
echo %BASE_DIR%release\xjskp-sync-multi-next
echo Use the portable package entrypoint after creating the portable package.
echo.
pause
exit /b 1

:runLocal
cd /d "%BASE_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%BASE_DIR%work\run-auto-plant.ps1" -Loop
set "exitCode=%ERRORLEVEL%"
echo.
if not "%exitCode%"=="0" (
  echo Auto plant failed with exit code %exitCode%.
) else (
  echo Auto garden loop stopped.
)
echo.
pause
exit /b %exitCode%
