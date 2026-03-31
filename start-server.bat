@echo off
REM Double-click this file on Windows to start the FPXpress LangGraph server.
REM It will install dependencies (if needed) and launch the server.

cd /d "%~dp0server"

echo =========================================
echo   FPXpress LangGraph Server
echo =========================================
echo.

if not exist "node_modules" (
    echo Installing dependencies (first run)...
    call npm install
    echo.
)

echo Starting server on http://localhost:3210 ...
echo Press Ctrl+C to stop.
echo.
node index.js
pause
