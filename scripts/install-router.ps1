$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $env:USERPROFILE "bin"
New-Item -ItemType Directory -Force $bin | Out-Null
$launcher = Join-Path $bin "Router.cmd"
# A one-line shim: all startup logic stays in the repository (bin\Router.cmd -> scripts\router.mjs).
@"
@echo off
call "$repo\bin\Router.cmd" %*
exit /b %errorlevel%
"@ | Set-Content -Encoding ASCII $launcher
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($userPath -split ";" | Where-Object { $_ })
if ($parts -notcontains $bin) {
  [Environment]::SetEnvironmentVariable("Path", (($parts + $bin) -join ";"), "User")
}
Write-Host "Router command installed."
Write-Host "Open a new PowerShell or CMD window and run: Router"
