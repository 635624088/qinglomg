@echo off
title query latest xjskp game version
setlocal
cd /d "%~dp0"

set "NODE_EXE=node"
if exist "%~dp0bin\node\node.exe" set "NODE_EXE=%~dp0bin\node\node.exe"

"%NODE_EXE%" "%~dp0work\query-official-game-version.mjs"
set "exitCode=%ERRORLEVEL%"
echo.
pause
exit /b %exitCode%
