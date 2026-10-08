@echo off
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 or newer is required.
  echo Download Node.js from https://nodejs.org/
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server.js
