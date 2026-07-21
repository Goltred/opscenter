# Single-command A3Panel start (loads env, builds UI, runs API+UI on one port).
#
#   .\run-server.ps1
#   .\run-server.ps1 -EnvFile .\control-plane.env
#
# Equivalent from repo root:  npm start

param(
    [string]$EnvFile = ".\control-plane.env",
    [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = "Stop"

if (Test-Path $EnvFile) {
    Write-Host "Loading env from $EnvFile"
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*#') { return }
        if ($_ -match '^\s*([^=#]+?)\s*=\s*(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
        }
    }
}

Push-Location $RepoRoot
try {
    npm start
} finally {
    Pop-Location
}
