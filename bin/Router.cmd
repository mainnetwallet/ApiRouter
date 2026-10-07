@echo off
rem Router: thin Windows launcher (PowerShell and CMD).
rem It only checks that Node.js exists and hands over to the canonical startup
rem logic in scripts\router.mjs, the same file bin/Router uses on Linux/macOS.
where node >nul 2>nul
if errorlevel 1 (
  echo Router: Node.js was not found on PATH. Install Node.js 20 or newer from https://nodejs.org 1>&2
  exit /b 127
)
node "%~dp0..\scripts\router.mjs" %*
exit /b %errorlevel%
