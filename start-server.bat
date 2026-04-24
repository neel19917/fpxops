@echo off
REM FPXpress API server launcher — Windows.
REM Double-click to start. Keep this window open while you use the extension.

cd /d "%~dp0\server"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is not installed.
  echo     Install from https://nodejs.org ^(LTS version^) and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [*] First-time setup - installing dependencies...
  call npm install
)

if not exist .env (
  echo [!] server\.env not found. Copy .env.example to .env and fill in the values from your admin.
  copy .env.example .env >nul
  echo     Template written to server\.env - edit it, then run this script again.
  pause
  exit /b 1
)

echo.
echo [+] Starting FPX API on http://localhost:3210
echo     (keep this window open while you use the extension)
echo.
node index.js
pause
