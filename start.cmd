@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  CampusQA launcher
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js was not found on PATH.
  echo         Install Node.js 20 or newer from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [info] node_modules is missing, running npm install ...
  call npm install
  if errorlevel 1 (
    echo [error] npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

if not exist ".env" echo [warn] No .env file found. The server will run in offline mode. Copy .env.example to .env to enable the model.

echo [info] Building the frontend ...
call npm run build
if errorlevel 1 (
  echo [error] npm run build failed. See the messages above.
  pause
  exit /b 1
)

echo [info] Starting the server. The browser opens in about 8 seconds.
echo [info] Address: http://localhost:3000
echo [info] If you changed PORT in .env, open that address manually.
echo [info] Press Ctrl+C to stop the server.
start "" /min cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:3000"

call npm start
set "EXITCODE=%errorlevel%"
if not "%EXITCODE%"=="0" (
  echo [error] The server stopped with exit code %EXITCODE%.
  pause
)
endlocal & exit /b %EXITCODE%
