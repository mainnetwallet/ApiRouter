@echo off
setlocal
cd /d "%~dp0.."
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)
if not exist "ui\dist\index.html" (
  echo Building Control Panel...
  call npm run ui:build
  if errorlevel 1 exit /b 1
)
start "" "http://127.0.0.1:8788"
call npm start
