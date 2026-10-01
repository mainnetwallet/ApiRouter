$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $env:USERPROFILE "bin"
New-Item -ItemType Directory -Force $bin | Out-Null
$launcher = Join-Path $bin "Router.cmd"
@"
@echo off
call "$repo\bin\Router.cmd"
"@ | Set-Content -Encoding ASCII $launcher
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($userPath -split ";" | Where-Object { $_ })
if ($parts -notcontains $bin) {
  [Environment]::SetEnvironmentVariable("Path", (($parts + $bin) -join ";"), "User")
}
Write-Host "Router command installed."
Write-Host "Open a new PowerShell and run: Router"
