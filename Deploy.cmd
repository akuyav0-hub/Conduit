@echo off
title Conduit deploy
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Conduit needs Node.js to deploy. Opening the download page...
  echo Install the LTS version, then double-click Deploy again.
  start "" https://nodejs.org/en/download
  echo.
  pause
  exit /b 1
)
node scripts\deploy.mjs
echo.
pause
