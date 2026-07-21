# Installs / runs the A3Panel C# host agent.
#
#   .\install-agent.ps1 -Config .\agent.json
#   .\install-agent.ps1 -Config .\agent.json -Service   # Windows Service (Admin)

param(
    [string]$Config = "",
    [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path,
    [switch]$Service,
    [switch]$Build
)

$ErrorActionPreference = "Stop"
$agentDir = Join-Path $RepoRoot "agent-csharp"
Push-Location $agentDir
try {
    if ($Build -or -not (Test-Path ".\bin\Release\net8.0\a3panel-agent.exe")) {
        Write-Host "Building agent..."
        dotnet publish -c Release -o .\publish
    }
    $cfg = if ($Config) { Resolve-Path $Config } else { Join-Path $agentDir "agent.json" }
    if (-not (Test-Path $cfg)) {
        Copy-Item (Join-Path $agentDir "agent.example.json") $cfg
        Write-Host "Created $cfg — edit hostId, controlPlaneUrl, armaRoot, and steamCmdPath, then re-run."
        exit 1
    }
    Copy-Item $cfg (Join-Path $agentDir "publish\agent.json") -Force

    if ($Service) {
        $exe = Join-Path $agentDir "publish\a3panel-agent.exe"
        $name = "A3PanelAgent"
        if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
            Stop-Service $name -Force -ErrorAction SilentlyContinue
            sc.exe delete $name | Out-Null
            Start-Sleep 2
        }
        New-Service -Name $name -BinaryPathName "`"$exe`"" -DisplayName "A3Panel Host Agent" -StartupType Automatic
        Start-Service $name
        Write-Host "Service $name installed and started."
    } else {
        Write-Host "Starting agent (foreground)..."
        & (Join-Path $agentDir "publish\a3panel-agent.exe")
    }
} finally {
    Pop-Location
}
