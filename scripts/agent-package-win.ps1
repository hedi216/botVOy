param(
  [switch]$SkipTests,
  [switch]$SkipInstaller
)

# Phase 5 (Lot 1+2+3) : construit un runtime agent COMPILE et AUTONOME, puis
# un installateur Windows per-user reellement testable.
#
# Lot 3 (voir docs/agent-packaging.md section 12 pour l'audit complet) :
# - Node SEA prototype avec les dependances reelles puis REJETE (cause
#   documentee : requetes require() de node_modules impossibles depuis un
#   script embarque SEA sans bundle 100% autonome, et playwright-core casse
#   une fois bundle car il recherche son propre package.json via un chemin
#   relatif calcule a l'execution).
# - Architecture retenue : copie privee de node.exe (jamais le node.exe
#   systeme modifie), renommee RendezBotAgent.exe, embarquee avec le
#   node_modules reel (deja valide au Lot 1) - aucune installation Node.js
#   separee requise cote client.
# - Installateur Inno Setup (ISCC), per-user, sans droits administrateur.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\agent-package-win.ps1
#   npm run agent:package:win
#
# -SkipTests: pour iterer rapidement (jamais pour un build distribue/teste).
# -SkipInstaller: construit uniquement le runtime autonome, sans passer par
#   ISCC (utile si Inno Setup n'est pas installe sur la machine courante).
#
# Variables d'environnement optionnelles (section 17, jamais un chemin
# hardcode propre a une seule machine) :
#   AGENT_EMBEDDED_NODE_PATH  chemin vers le node.exe a copier/embarquer
#                             (defaut: celui qui execute ce script).
#   INNO_SETUP_COMPILER_PATH  chemin vers ISCC.exe (defaut: recherche dans
#                             les emplacements d'installation standard).

$ErrorActionPreference = "Stop"

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Sha256Hex {
  param([string]$Path)
  return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseRoot = Join-Path $root "release"
$release = Join-Path $releaseRoot "agent-win"
$appDir = Join-Path $release "app"
$windowsOutDir = Join-Path $releaseRoot "windows"

Write-Host "=== RendezBot Agent - build (runtime autonome + installateur) ==="

Push-Location $root
try {
  if (Test-Path (Join-Path $root "dist")) { Remove-Item (Join-Path $root "dist") -Recurse -Force }
  if (Test-Path $release) { Remove-Item $release -Recurse -Force }
  if (Test-Path $windowsOutDir) { Remove-Item $windowsOutDir -Recurse -Force }

  Write-Host "--- Verification de types (tsc --noEmit) ---"
  npx tsc --noEmit
  if ($LASTEXITCODE -ne 0) { throw "tsc --noEmit a echoue." }

  if (-not $SkipTests) {
    Write-Host "--- Non-regression Phase 4 (test:phase4:final:simulated) ---"
    npm.cmd run test:phase4:final:simulated
    if ($LASTEXITCODE -ne 0) { throw "La regression Phase 4 simulee a echoue: le build agent est refuse." }

    Write-Host "--- Non-regression packaging Lot 2 (test:agent:packaging-lot2:simulated) ---"
    npm.cmd run test:agent:packaging-lot2:simulated
    if ($LASTEXITCODE -ne 0) { throw "La regression packaging Lot 2 a echoue: le build agent est refuse." }
  } else {
    Write-Host "--- Tests ignores (-SkipTests): build non destine a la distribution/aux tests reels ---"
  }

  Write-Host "--- Compilation (tsc) ---"
  npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "La compilation a echoue." }
} finally {
  Pop-Location
}

# Fermeture de dependance de l'agent verifiee au Lot 1 (audit, section 1):
# dist/agent, dist/shared, et dist/logger.js UNIQUEMENT (src/shared importe
# src/logger.ts, rien d'autre hors de agent/shared n'est requis). Jamais
# dist/server.js, dist/db.js, dist/agentGateway.js ni aucun fichier lie a
# PostgreSQL/Express. Jamais scripts/fixtures/ ni aucun fichier de test.
Write-Host "--- Copie des fichiers necessaires a l'agent uniquement ---"
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "agent") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "shared") | Out-Null
Copy-Item -Path (Join-Path $root "dist\agent\*") -Destination (Join-Path $appDir "agent") -Recurse
Copy-Item -Path (Join-Path $root "dist\shared\*") -Destination (Join-Path $appDir "shared") -Recurse
Copy-Item -Path (Join-Path $root "dist\logger.js") -Destination (Join-Path $appDir "logger.js")

Copy-Item -Path (Join-Path $root "scripts\agent-launch-no-console.vbs") -Destination (Join-Path $appDir "agent-launch-no-console.vbs")

# package.json minimal: UNIQUEMENT les 3 dependances runtime reellement
# importees par src/agent et src/shared (verifie par grep exhaustif, voir
# docs/agent-packaging.md) - jamais express/pg/cookie-parser/socket.io
# (serveur uniquement). Versions figees depuis package-lock.json (racine)
# pour un build reproductible, jamais un intervalle "^".
$sourcePackage = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$pinnedVersionsJson = node -e "const l=require(process.argv[1]); const names=['playwright','socket.io-client','dotenv']; const out={}; for (const n of names) out[n]=l.packages['node_modules/'+n].version; console.log(JSON.stringify(out));" (Join-Path $root "package-lock.json")
if ($LASTEXITCODE -ne 0) { throw "Extraction des versions figees (package-lock.json) a echoue." }
$pinnedVersions = $pinnedVersionsJson | ConvertFrom-Json

$agentPackage = [ordered]@{
  name = "rendezbot-agent"
  version = $sourcePackage.version
  private = $true
  main = "agent/agentMain.js"
  dependencies = [ordered]@{
    playwright = $pinnedVersions.playwright
    "socket.io-client" = $pinnedVersions."socket.io-client"
    dotenv = $pinnedVersions.dotenv
  }
}
Write-Utf8NoBom -Path (Join-Path $appDir "package.json") -Content ($agentPackage | ConvertTo-Json -Depth 8)

Write-Host "--- Installation des dependances runtime agent uniquement (playwright, socket.io-client, dotenv) ---"
Push-Location $appDir
try {
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
  npm.cmd install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install (dependances agent) a echoue." }
} finally {
  Pop-Location
  Remove-Item Env:\PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD -ErrorAction SilentlyContinue
}

# --- Lot 3: runtime Node embarque (copie privee, jamais le node.exe systeme modifie) ---
Write-Host "--- Copie du runtime Node embarque (RendezBotAgent.exe) ---"
$embeddedNodeSource = $env:AGENT_EMBEDDED_NODE_PATH
if (-not $embeddedNodeSource) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    throw "Node.js introuvable pour construire le runtime embarque. Definissez AGENT_EMBEDDED_NODE_PATH."
  }
  $embeddedNodeSource = $nodeCmd.Source
}
if (-not (Test-Path $embeddedNodeSource)) {
  throw "AGENT_EMBEDDED_NODE_PATH ne pointe vers aucun fichier existant: $embeddedNodeSource"
}
$embeddedNodeDest = Join-Path $appDir "RendezBotAgent.exe"
Copy-Item -Path $embeddedNodeSource -Destination $embeddedNodeDest
Write-Host "Runtime embarque: $embeddedNodeSource -> $embeddedNodeDest"

Write-Host "--- Verification anti-secret (aucune chaine interdite dans le dossier livre) ---"
$forbiddenPatterns = @("BREVO_API_KEY", "PGPASSWORD", "HtlsH2030", "POSTGRES_PASSWORD", "PGUSER", "PGDATABASE")
$offending = @()
Get-ChildItem -Path $appDir -Recurse -File -Include *.js,*.json,*.ts,*.vbs | ForEach-Object {
  $content = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
  if ($content) {
    foreach ($pattern in $forbiddenPatterns) {
      if ($content -match [regex]::Escape($pattern)) {
        $offending += "$($_.FullName): $pattern"
      }
    }
  }
}
if ($offending.Count -gt 0) {
  throw "Chaine(s) interdite(s) trouvee(s) dans le build agent:`n$($offending -join "`n")"
}
Write-Host "Aucune chaine interdite trouvee."

# --- Verification: le contrat "aucune dependance a Node installe" est reel ---
Write-Host "--- Verification: RendezBotAgent.exe demarre sans Node.js sur le PATH ---"
$verifyDataRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("rendezbot-verify-" + [Guid]::NewGuid().ToString("N"))
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $embeddedNodeDest
  $psi.Arguments = "agent\agentMain.js"
  $psi.WorkingDirectory = $appDir
  $psi.EnvironmentVariables["PATH"] = ""
  $psi.EnvironmentVariables["SystemRoot"] = $env:SystemRoot
  $psi.EnvironmentVariables["AGENT_DATA_DIR"] = $verifyDataRoot
  $psi.EnvironmentVariables["AGENT_SERVER_URL"] = "http://127.0.0.1:1"
  # Cette verification cible UNIQUEMENT l'absence de dependance Node.js
  # systeme - jamais le comportement packaged/DPAPI (le detecteur
  # automatique de mode packaged, base sur le nom de l'executable, ferait
  # sinon echouer DPAPI a cause du PATH vide ci-dessus, ce qui est un
  # probleme distinct, deja couvert par ses propres tests).
  $psi.EnvironmentVariables["AGENT_RUNTIME_MODE"] = "development"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  Start-Sleep -Seconds 3
  $started = -not $proc.HasExited
  if (-not $proc.HasExited) { $proc.Kill() }
  if (-not $started) { throw "RendezBotAgent.exe s'est termine immediatement (verifier les logs)." }
  Write-Host "OK: RendezBotAgent.exe demarre avec PATH vide (aucune dependance a un Node.js systeme)."
} finally {
  if (Test-Path $verifyDataRoot) { Remove-Item $verifyDataRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

# --- Inno Setup (installateur per-user) ---
$agentVersionInfo = Get-Content (Join-Path $root "src\agent\agentVersionInfo.json") -Raw | ConvertFrom-Json
$installerBuilt = $false
$installerPath = $null

if (-not $SkipInstaller) {
  Write-Host "--- Construction de l'installateur (Inno Setup) ---"
  $isccPath = $env:INNO_SETUP_COMPILER_PATH
  if (-not $isccPath) {
    $candidates = @(
      (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
      "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
      "C:\Program Files\Inno Setup 6\ISCC.exe"
    )
    $isccPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  }
  if (-not $isccPath -or -not (Test-Path $isccPath)) {
    throw "Compilateur Inno Setup (ISCC.exe) introuvable. Installez Inno Setup 6 ou definissez INNO_SETUP_COMPILER_PATH. Utilisez -SkipInstaller pour construire uniquement le runtime autonome."
  }
  Write-Host "ISCC: $isccPath"

  New-Item -ItemType Directory -Force -Path $windowsOutDir | Out-Null
  & $isccPath "/DMyAppVersion=$($agentVersionInfo.agentVersion)" "/DSourceDir=$appDir" (Join-Path $root "scripts\agent-installer.iss")
  if ($LASTEXITCODE -ne 0) { throw "La compilation Inno Setup a echoue." }

  $installerPath = Join-Path $windowsOutDir "RendezBotAgentSetup-$($agentVersionInfo.agentVersion).exe"
  if (-not (Test-Path $installerPath)) { throw "Installateur attendu introuvable apres compilation: $installerPath" }
  $installerBuilt = $true
  Write-Host "Installateur: $installerPath"
} else {
  Write-Host "--- Installateur ignore (-SkipInstaller) ---"
  New-Item -ItemType Directory -Force -Path $windowsOutDir | Out-Null
}

# --- Manifeste de build (section 13) et hashes (section 14) ---
Write-Host "--- Generation du manifeste de build et des hashes ---"
$commit = (git -C $root rev-parse HEAD 2>$null)
if (-not $commit) { $commit = "unknown" }
$builtAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

$versionInfo = [ordered]@{
  agentVersion = $agentVersionInfo.agentVersion
  protocolVersion = $agentVersionInfo.protocolVersion
  gitCommit = $commit
  buildDate = $builtAt
}
Write-Utf8NoBom -Path (Join-Path $release "version.json") -Content ($versionInfo | ConvertTo-Json)
Copy-Item -Path (Join-Path $release "version.json") -Destination (Join-Path $appDir "version.json")

$fileEntries = @()
Get-ChildItem -Path $appDir -Recurse -File | ForEach-Object {
  $relativePath = "app/" + ($_.FullName.Substring($appDir.ToString().Length + 1) -replace '\\', '/')
  $fileEntries += [ordered]@{ name = $relativePath; sha256 = (Get-Sha256Hex $_.FullName); size = $_.Length }
}
if ($installerBuilt) {
  $fileEntries += [ordered]@{
    name = "windows/" + (Split-Path $installerPath -Leaf)
    sha256 = (Get-Sha256Hex $installerPath)
    size = (Get-Item $installerPath).Length
  }
}

$buildManifest = [ordered]@{
  product = "RendezBot Agent"
  agentVersion = $agentVersionInfo.agentVersion
  protocolVersion = $agentVersionInfo.protocolVersion
  commit = $commit
  builtAt = $builtAt
  architecture = "x64"
  packaging = "embedded-node-copy"
  installer = $(if ($installerBuilt) { "inno-setup" } else { $null })
  signed = $false
  files = $fileEntries
}
Write-Utf8NoBom -Path (Join-Path $windowsOutDir "build-manifest.json") -Content ($buildManifest | ConvertTo-Json -Depth 8)
Write-Utf8NoBom -Path (Join-Path $release "build-manifest.json") -Content ($buildManifest | ConvertTo-Json -Depth 8)

$sumsLines = $fileEntries | ForEach-Object { "$($_.sha256)  $($_.name)" }
($sumsLines -join "`r`n") | Set-Content -Path (Join-Path $windowsOutDir "SHA256SUMS.txt") -Encoding ASCII
($sumsLines -join "`r`n") | Set-Content -Path (Join-Path $release "SHA256SUMS.txt") -Encoding ASCII

Write-Host ""
Write-Host "Build agent pret: $appDir"
if ($installerBuilt) {
  Write-Host "Installateur pret: $installerPath"
} else {
  Write-Host "Aucun installateur construit (-SkipInstaller)."
}
Write-Host "Manifeste: $(Join-Path $windowsOutDir 'build-manifest.json')"
Write-Host "Hashes: $(Join-Path $windowsOutDir 'SHA256SUMS.txt')"
Write-Host "Aucun artefact n'est signe (voir docs/agent-signing.md)."
