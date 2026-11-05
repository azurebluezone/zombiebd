# install.ps1 - Windows installer for ZombieCoder (PowerShell)
# Requires Node 24+, Caddy. Uses NSSM or sc.exe for services.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "[install.ps1] ZombieCoder installer (Windows)" -ForegroundColor Cyan
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "Node.js not found"; exit 1 }
$ver = [int](node -e "console.log(process.versions.node.split('.')[0])")
if ($ver -lt 24) { Write-Error "Node >= 24 required"; exit 1 }

if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env"; Write-Host "[install.ps1] Copied .env.example -> .env" }

Write-Host "[install.ps1] To register services, use NSSM or New-Service."
Write-Host "[install.ps1] Caddy: download from https://caddyserver.com/download or winget."
Write-Host "[install.ps1] Done."
