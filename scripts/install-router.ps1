$ErrorActionPreference = "Stop"

if (-not $env:USERPROFILE) {
    Write-Error "USERPROFILE environment variable is missing or empty."
    exit 1
}

$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$targetCmd = Join-Path $repoRoot "bin\Router.cmd"

if (-not (Test-Path $targetCmd)) {
    Write-Error "Launcher script not found at expected path: $targetCmd"
    exit 1
}

$userBin = Join-Path $env:USERPROFILE "bin"
if (-not (Test-Path $userBin)) {
    New-Item -ItemType Directory -Force -Path $userBin | Out-Null
}

$wrapperPath = Join-Path $userBin "Router.cmd"
$wrapperContent = "@echo off`r`ncall `"$targetCmd`" %*`r`n"
[System.IO.File]::WriteAllText($wrapperPath, $wrapperContent, [System.Text.Encoding]::ASCII)

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($null -eq $userPath) { $userPath = "" }

$normalizedBin = $userBin.TrimEnd("\/").ToLowerInvariant()
$existingPaths = @($userPath -split ";" | Where-Object { $_ } | ForEach-Object { $_.TrimEnd("\/").ToLowerInvariant() })

if ($existingPaths -notcontains $normalizedBin) {
    $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $userBin } else { "$userPath;$userBin" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "Added $userBin to User PATH."
}

Write-Host "Router command wrapper installed successfully at:"
Write-Host "  $wrapperPath"
Write-Host "Open a new PowerShell or Command Prompt window and run: Router"

