# Installs and bootstraps the OpsCenter control plane on Windows.
#
#   .\install-opscenter.ps1
#   .\install-opscenter.ps1 -AgentZip .\opscenter-agent-win-x64.zip
#   .\install-opscenter.ps1 -SkipAgent -NoStart
#   .\install-opscenter.ps1 -NonInteractive
#
# After install: sign in at http://localhost:8080 and follow the setup wizard.

param(
    [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path,
    [string]$EnvFile = "",
    [string]$AgentZip = "",
    [switch]$SkipAgent,
    [switch]$NoStart,
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot "control-plane.env" }

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-Command([string]$Name) {
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-NodeMajorVersion {
    if (-not (Test-Command "node")) { return 0 }
    $v = (node -v) -replace '^v', ''
    $major = [int]($v.Split('.')[0])
    return $major
}

function Ensure-Node {
    $major = Get-NodeMajorVersion
    if ($major -ge 20) {
        Write-Host "Node.js $((node -v)) OK"
        return
    }
    Write-Host "Node.js 20+ is required (found: $(if ($major) { "v$major" } else { "none" }))."
    if ($NonInteractive) { throw "Install Node.js 20+ and re-run." }
    $ans = Read-Host "Try installing via winget? (Y/n)"
    if ($ans -eq 'n' -or $ans -eq 'N') { throw "Install Node.js 20+ from https://nodejs.org/ and re-run." }
    if (-not (Test-Command "winget")) { throw "winget not found. Install Node.js 20+ manually." }
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $major = Get-NodeMajorVersion
    if ($major -lt 20) { throw "Node.js still not available. Open a new terminal and re-run." }
}

function Read-EnvFile([string]$Path) {
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    Get-Content $Path | ForEach-Object {
        if ($_ -match '^\s*#') { return }
        if ($_ -match '^\s*([^=#]+?)\s*=\s*(.*)$') {
            $map[$matches[1].Trim()] = $matches[2].Trim()
        }
    }
    return $map
}

function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
    $lines = @()
    $found = $false
    if (Test-Path $Path) {
        $lines = Get-Content $Path
        $lines = $lines | ForEach-Object {
            if ($_ -match "^\s*$([regex]::Escape($Key))\s*=") {
                $found = $true
                "$Key=$Value"
            } else { $_ }
        }
    }
    if (-not $found) {
        if ($lines.Count -eq 0) {
            $example = Join-Path $PSScriptRoot "control-plane.env.example"
            if (Test-Path $example) { $lines = Get-Content $example }
        }
        $lines += "$Key=$Value"
    }
    $lines | Set-Content -Path $Path -Encoding UTF8
}

function New-SecretsKey {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes)
}

function Prompt-Required([string]$Label, [string]$Default = "") {
    while ($true) {
        $hint = if ($Default) { " [$Default]" } else { "" }
        $val = Read-Host "$Label$hint"
        if (-not $val) { $val = $Default }
        if ($val) { return $val.Trim() }
        Write-Host "  Required." -ForegroundColor Yellow
    }
}

function Configure-EnvInteractive([string]$Path) {
    Write-Step "Panel configuration"
    $current = Read-EnvFile $Path

    $publicUrl = $current["OC_PUBLIC_URL"]
    if (-not $publicUrl) { $publicUrl = "http://localhost:8080" }
    $publicUrl = Prompt-Required "Panel URL (OC_PUBLIC_URL)" $publicUrl
    Set-EnvValue $Path "OC_PUBLIC_URL" $publicUrl
    Set-EnvValue $Path "OC_HTTP_ADDR" ":8080"
    Set-EnvValue $Path "OC_WEB_ORIGIN" $publicUrl
    Set-EnvValue $Path "OC_DEV_MODE" "true"
    if (-not $current["OC_DATABASE_URL"]) {
        Set-EnvValue $Path "OC_DATABASE_URL" "../deploy/OpsCenter.sqlite"
    }
    if (-not $current["OC_AGENT_ADDR"]) {
        Set-EnvValue $Path "OC_AGENT_ADDR" ":8443"
    }

    if (-not $current["OC_SECRETS_KEY"]) {
        $key = New-SecretsKey
        Set-EnvValue $Path "OC_SECRETS_KEY" $key
        Write-Host "Generated OC_SECRETS_KEY (encrypts Steam passwords in the database)."
    }

    $owners = $current["OC_BOOTSTRAP_OWNERS"]
    if (-not $owners) {
        Write-Host ""
        Write-Host "First Owner allowlist (OC_BOOTSTRAP_OWNERS)"
        Write-Host "  Discord: enable Developer Mode, right-click your user, Copy User ID"
        Write-Host "  Format: discord:123456789012345678"
        $owners = Prompt-Required "Bootstrap Owner (provider:subject)"
        Set-EnvValue $Path "OC_BOOTSTRAP_OWNERS" $owners
    }

    $hasOAuth = $false
    foreach ($k in @("OC_OAUTH_DISCORD_CLIENT_ID", "OC_OAUTH_GOOGLE_CLIENT_ID", "OC_OAUTH_MICROSOFT_CLIENT_ID")) {
        if ($current[$k]) { $hasOAuth = $true; break }
    }
    if ($current["OC_OAUTH_STEAM"] -eq "1") { $hasOAuth = $true }

    if (-not $hasOAuth) {
        Write-Host ""
        Write-Host "OAuth provider (for panel sign-in)"
        Write-Host "  Redirect URI: $publicUrl/api/auth/oauth/<provider>/callback"
        Write-Host "  1 = Discord  2 = Google  3 = Microsoft  4 = Skip (configure env manually)"
        $pick = Read-Host "Choose provider"
        switch ($pick) {
            "1" {
                $id = Prompt-Required "Discord Client ID"
                $secret = Prompt-Required "Discord Client Secret"
                Set-EnvValue $Path "OC_OAUTH_DISCORD_CLIENT_ID" $id
                Set-EnvValue $Path "OC_OAUTH_DISCORD_CLIENT_SECRET" $secret
            }
            "2" {
                $id = Prompt-Required "Google Client ID"
                $secret = Prompt-Required "Google Client Secret"
                Set-EnvValue $Path "OC_OAUTH_GOOGLE_CLIENT_ID" $id
                Set-EnvValue $Path "OC_OAUTH_GOOGLE_CLIENT_SECRET" $secret
            }
            "3" {
                $id = Prompt-Required "Microsoft Client ID"
                $secret = Prompt-Required "Microsoft Client Secret"
                Set-EnvValue $Path "OC_OAUTH_MICROSOFT_CLIENT_ID" $id
                Set-EnvValue $Path "OC_OAUTH_MICROSOFT_CLIENT_SECRET" $secret
            }
            default {
                Write-Host "Skipping OAuth prompts — edit $Path before signing in."
            }
        }
    } else {
        Write-Host "OAuth provider already configured in env."
    }
}

function Ensure-AgentPackage([string]$PublishDir, [string]$ZipPath) {
    $exe = Join-Path $PublishDir "opscenter-agent.exe"
    if (Test-Path $exe) {
        Write-Host "Agent binary OK: $exe"
        return
    }

    if ($ZipPath) {
        Write-Step "Extracting pre-built agent from $ZipPath"
        if (-not (Test-Path $ZipPath)) { throw "Agent zip not found: $ZipPath" }
        New-Item -ItemType Directory -Force -Path $PublishDir | Out-Null
        Expand-Archive -Path $ZipPath -DestinationPath $PublishDir -Force
        if (Test-Path $exe) { return }
        # Zip may contain a subfolder
        $nested = Get-ChildItem -Path $PublishDir -Recurse -Filter "opscenter-agent.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($nested) {
            Write-Host "Found agent at $($nested.FullName) — copy contents to $PublishDir if downloads fail."
            return
        }
        throw "Zip did not contain opscenter-agent.exe"
    }

    if (-not (Test-Command "dotnet")) {
        throw @"
.NET 8 SDK is required to build the host agent, or pass -AgentZip if you already have a zip.
  Install SDK: winget install Microsoft.DotNet.SDK.8
  Or: .\install-opscenter.ps1 -AgentZip path\to\opscenter-agent.zip
"@
    }

    Write-Step "Building host agent (dotnet publish)"
    $agentDir = Join-Path $RepoRoot "agent-csharp"
    Push-Location $agentDir
    try {
        dotnet publish -c Release -o $PublishDir
    } finally {
        Pop-Location
    }

    if (-not (Test-Path $exe)) { throw "dotnet publish did not produce $exe" }
    Write-Host "Agent built: $exe"
}

# --- main ---

Write-Host "OpsCenter installer" -ForegroundColor Green
Write-Host "Repo: $RepoRoot"

Ensure-Node

Write-Step "Installing npm dependencies"
Push-Location $RepoRoot
try {
    npm run install:all
} finally {
    Pop-Location
}

$example = Join-Path $PSScriptRoot "control-plane.env.example"
if (-not (Test-Path $EnvFile)) {
    Write-Step "Creating $EnvFile"
    if (-not (Test-Path $example)) { throw "Missing $example" }
    Copy-Item $example $EnvFile
}

if (-not $NonInteractive) {
    Configure-EnvInteractive $EnvFile
} else {
    Write-Host "NonInteractive: using existing $EnvFile"
}

$publishDir = Join-Path $RepoRoot "agent-csharp\publish"
if (-not $SkipAgent) {
    Ensure-AgentPackage $publishDir $AgentZip
} else {
    Write-Host "Skipping agent build (-SkipAgent)."
}

Write-Step "Done"
Write-Host @"

Next steps:
  1. Start the panel (if not started below):  npm start
  2. Open http://localhost:8080
  3. Sign in with your OAuth provider (bootstrap Owner from OC_BOOTSTRAP_OWNERS)
  4. Complete the setup wizard — Steam account, then your first game host

Manual reference: docs\INSTALL.md
Day-to-day guide:   docs\SETUP.md

"@

if ($NoStart) {
    Write-Host "Skipped start (-NoStart)."
    exit 0
}

Write-Step "Starting panel (Ctrl+C to stop)"
# scripts/start.mjs loads deploy/control-plane.env automatically
Push-Location $RepoRoot
try {
    npm start
} finally {
    Pop-Location
}
