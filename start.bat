@echo off
setlocal
cd /d "%~dp0"
title CogniStack High-Concurrency Cluster
echo.
echo  ======================================================
echo   CogniStack - Multi-Worker Cluster Launcher
echo  ======================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js not found. Please install Node.js: https://nodejs.org/
  echo.
  pause
  exit /b 1
)
node scripts\start-all.cjs %*
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo  Start failed ^(code %ERR%^).
  echo.
  pause
  exit /b %ERR%
)
