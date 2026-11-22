@echo off
setlocal
if /i not "%~1"=="--console" (
  "%ComSpec%" /d /k call "%~f0" --console
  exit /b
)
title Nautilo
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and open this launcher again.
  goto failed
)
where pnpm >nul 2>&1
if errorlevel 1 (
  echo pnpm was not found. Run: corepack enable
  goto failed
)
if not exist "apps\desktop\node_modules\electron\dist\electron.exe" (
  echo Desktop dependencies were not found. Run: pnpm install
  goto failed
)

set "AGENTHUB_NODE_PATH="
for /f "delims=" %%I in ('where node.exe') do if not defined AGENTHUB_NODE_PATH set "AGENTHUB_NODE_PATH=%%I"
echo Starting Nautilo with the existing Rust build...
echo Keep this window open while using Nautilo.
node "scripts\start-desktop-preview.mjs"
set "NAUTILO_LAUNCH_EXIT=%ERRORLEVEL%"
if not "%NAUTILO_LAUNCH_EXIT%"=="0" goto failed
exit /b 0

:failed
echo.
echo Nautilo could not start. The error is shown above.
pause
exit /b 1

