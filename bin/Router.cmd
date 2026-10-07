@echo off
setlocal
cd /d "%~dp0.."
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)
rem Same two steps as `npm start` (UI build, then gateway), split only so the browser
rem opens once the build is done and the gateway is about to listen.
echo Building Control Panel...
call npm run ui:build
if errorlevel 1 exit /b 1
start "" "http://localhost:999"
call node src/server.js
