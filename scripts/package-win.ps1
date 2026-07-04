$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseRoot = Join-Path $root "release"
$release = Join-Path $releaseRoot "RendezBot"

Write-Host "Building RendezBot..."
Push-Location $root
try {
  if (Test-Path (Join-Path $root "dist")) {
    Remove-Item (Join-Path $root "dist") -Recurse -Force
  }
  npm.cmd run build
} finally {
  Pop-Location
}

if (Test-Path $release) {
  Remove-Item $release -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $release | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $release "scripts") | Out-Null

Copy-Item -Path (Join-Path $root "dist") -Destination (Join-Path $release "dist") -Recurse
Copy-Item -Path (Join-Path $root "public") -Destination (Join-Path $release "public") -Recurse
Copy-Item -Path (Join-Path $root ".env.example") -Destination (Join-Path $release ".env.example")
Copy-Item -Path (Join-Path $root "package-lock.json") -Destination (Join-Path $release "package-lock.json")
Copy-Item -Path (Join-Path $root "scripts\install-postgres-admin.ps1") -Destination (Join-Path $release "scripts\install-postgres-admin.ps1")

$sourcePackage = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$releasePackage = [ordered]@{
  name = "rendezbot"
  version = $sourcePackage.version
  private = $true
  main = "dist/server.js"
  scripts = [ordered]@{
    "web:start" = "node dist/server.js"
    "db:init" = "node dist/initDb.js"
    "start" = "node dist/server.js"
    "playwright:install" = "playwright install chromium"
  }
  dependencies = $sourcePackage.dependencies
}
$releasePackage | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $release "package.json") -Encoding UTF8

@"
@echo off
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env"
npm.cmd install --omit=dev
pause
"@ | Set-Content -Path (Join-Path $release "install-deps.bat") -Encoding ASCII

@"
@echo off
cd /d "%~dp0"
npm.cmd run db:init
pause
"@ | Set-Content -Path (Join-Path $release "init-db.bat") -Encoding ASCII

@"
@echo off
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env"
npm.cmd run web:start
pause
"@ | Set-Content -Path (Join-Path $release "start-rendezbot.bat") -Encoding ASCII

@"
@echo off
start http://localhost:3000
"@ | Set-Content -Path (Join-Path $release "open-rendezbot.bat") -Encoding ASCII

@"
RendezBot release package

1. Install Node.js LTS and Google Chrome on the VM.
2. Install PostgreSQL or run scripts\install-postgres-admin.ps1 as Administrator.
3. Run install-deps.bat.
4. Copy .env.example to .env if it does not exist, then fill Brevo and VM settings.
5. Run init-db.bat.
6. Run start-rendezbot.bat.
7. Open http://localhost:3000.

This package intentionally excludes src, .git, artifacts and development files.
"@ | Set-Content -Path (Join-Path $release "README-VM.txt") -Encoding UTF8

Write-Host "Release ready: $release"
