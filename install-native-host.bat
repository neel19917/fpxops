@echo off
REM Registers the FPXpress native messaging host with Chrome on Windows.
REM Run this ONCE after loading the extension. After that, the "Start Server"
REM button in the side panel will launch the API server for you.

setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "EXT_ID=%~1"
if "%EXT_ID%"=="" (
  echo ============================================================
  echo   FPXpress - Native host installer ^(one-time setup^)
  echo ============================================================
  echo.
  echo Find your extension ID:
  echo   1. Open  chrome://extensions  in Chrome
  echo   2. Turn on Developer Mode ^(top-right^)
  echo   3. Find 'FPXpress' and copy the ID under its name
  echo.
  set /p EXT_ID=Paste the extension ID:
)

if "%EXT_ID%"=="" (
  echo [X] No extension ID. Aborting.
  pause
  exit /b 1
)

REM Locate node
where node >nul 2>nul
if errorlevel 1 (
  echo [X] node is not installed. Install from https://nodejs.org and retry.
  pause
  exit /b 1
)
for /f "tokens=*" %%i in ('where node') do set "NODE_BIN=%%i"
echo   node: %NODE_BIN%

REM First-time npm install so the server can actually start.
if not exist server\node_modules (
  echo Installing server dependencies ^(one-time^)...
  pushd server
  call npm install
  popd
)

REM Write the launcher .bat that Chrome will actually call.
set "LAUNCHER=%CD%\native-host\host-launcher.bat"
(
  echo @echo off
  echo "%NODE_BIN%" "%CD%\native-host\host.js"
) > "%LAUNCHER%"

REM Write the native host manifest and registry entry.
set "HOST_NAME=com.fpxpress.server"
set "MANIFEST=%CD%\native-host\%HOST_NAME%.json"
(
  echo {
  echo   "name": "%HOST_NAME%",
  echo   "description": "FPXpress API server launcher",
  echo   "path": "%LAUNCHER:\=\\%",
  echo   "type": "stdio",
  echo   "allowed_origins": ["chrome-extension://%EXT_ID%/"]
  echo }
) > "%MANIFEST%"

REM Register with Chrome, Edge, and Brave
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul 2>nul

echo.
echo [+] Installed.
echo.
echo Next steps:
echo   1. Go to chrome://extensions and click reload on FPXpress.
echo   2. Open the FPXpress side panel.
echo   3. Click "Start Server" - the API will boot in the background.
echo.
pause
