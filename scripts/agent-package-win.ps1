param(
  [switch]$SkipTests
)

# Phase 5 (Lot 1+2): construit un runtime agent COMPILE (tsc, aucun tsx
# requis a l'execution) et autonome (dependances runtime propres, copiable et
# executable hors du depot), incluant depuis le Lot 2 le credential store
# DPAPI, l'interface locale d'appairage/diagnostic, le verrou mono-instance
# et le launcher candidat sans console. Ne produit PAS encore d'executable
# unique ni d'installateur: ces etapes sont reservees aux lots suivants (voir
# docs/agent-packaging.md).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\agent-package-win.ps1
#   npm run agent:package:win
#
# -SkipTests: pour iterer rapidement sur ce script uniquement (jamais pour
# un build destine a etre distribue ou teste reellement).

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 "Set-Content -Encoding UTF8" ecrit toujours un BOM,
# ce qui casse un JSON.parse() strict (trouve pendant la validation du Lot
# 1): les manifestes doivent rester un JSON strictement valide pour tout
# outil en aval (CI, scripts de verification).
function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseRoot = Join-Path $root "release"
$release = Join-Path $releaseRoot "agent-win"
$appDir = Join-Path $release "app"

Write-Host "=== RendezBot Agent - build Lot 1 (compile + dependances minimales) ==="

Push-Location $root
try {
  if (Test-Path (Join-Path $root "dist")) {
    Remove-Item (Join-Path $root "dist") -Recurse -Force
  }
  if (Test-Path $release) {
    Remove-Item $release -Recurse -Force
  }

  Write-Host "--- Verification de types (tsc --noEmit) ---"
  npx tsc --noEmit
  if ($LASTEXITCODE -ne 0) { throw "tsc --noEmit a echoue." }

  if (-not $SkipTests) {
    Write-Host "--- Non-regression Phase 4 (test:phase4:final:simulated) ---"
    npm.cmd run test:phase4:final:simulated
    if ($LASTEXITCODE -ne 0) { throw "La regression Phase 4 simulee a echoue: le build agent est refuse." }
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
# PostgreSQL/Express.
Write-Host "--- Copie des fichiers necessaires a l'agent uniquement ---"
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "agent") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "shared") | Out-Null
Copy-Item -Path (Join-Path $root "dist\agent\*") -Destination (Join-Path $appDir "agent") -Recurse
Copy-Item -Path (Join-Path $root "dist\shared\*") -Destination (Join-Path $appDir "shared") -Recurse
Copy-Item -Path (Join-Path $root "dist\logger.js") -Destination (Join-Path $appDir "logger.js")

# Lot 2: launcher candidat sans console (limites documentees dans le fichier
# lui-meme et docs/agent-packaging.md) - doit rester a cote de agent\agentMain.js.
Copy-Item -Path (Join-Path $root "scripts\agent-launch-no-console.vbs") -Destination (Join-Path $appDir "agent-launch-no-console.vbs")

# package.json minimal: UNIQUEMENT les 3 dependances runtime reellement
# importees par src/agent et src/shared (verifie par grep exhaustif, voir
# docs/agent-packaging.md) - jamais express/pg/cookie-parser/socket.io
# (serveur uniquement). Versions figees depuis package-lock.json (racine)
# pour un build reproductible, jamais un intervalle "^".
$sourcePackage = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
# package-lock.json contient une cle "" (racine du projet) que
# ConvertFrom-Json (Windows PowerShell 5.1) refuse de convertir en propriete
# PSCustomObject valide: extraction des versions figees via Node (deja
# disponible, deja utilise par tout le projet) plutot qu'un parsing PowerShell
# fragile de ce fichier.
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
  # Le runtime agent ne lance jamais Chromium via Playwright (uniquement
  # connectOverCDP vers un vrai Chrome systeme, voir agentBrowserManager.ts):
  # aucun besoin de telecharger les binaires navigateur Playwright ici.
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
  npm.cmd install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install (dependances agent) a echoue." }
} finally {
  Pop-Location
  Remove-Item Env:\PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD -ErrorAction SilentlyContinue
}

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

Write-Host "--- Generation de version.json et du manifeste de build ---"
$commit = (git -C $root rev-parse HEAD 2>$null)
if (-not $commit) { $commit = "unknown" }
$buildDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$agentVersionInfo = Get-Content (Join-Path $root "src\agent\agentVersionInfo.json") -Raw | ConvertFrom-Json

$versionInfo = [ordered]@{
  agentVersion = $agentVersionInfo.agentVersion
  protocolVersion = $agentVersionInfo.protocolVersion
  gitCommit = $commit
  buildDate = $buildDate
}
Write-Utf8NoBom -Path (Join-Path $release "version.json") -Content ($versionInfo | ConvertTo-Json)

$manifestEntries = Get-ChildItem -Path $release -Recurse -File | ForEach-Object {
  $hash = Get-FileHash -Path $_.FullName -Algorithm SHA256
  $relativePath = $_.FullName.Substring($release.ToString().Length + 1) -replace '\\', '/'
  [PSCustomObject]@{ path = $relativePath; sha256 = $hash.Hash }
}
($manifestEntries | ForEach-Object { "$($_.sha256)  $($_.path)" }) -join "`r`n" |
  Set-Content -Path (Join-Path $release "SHA256SUMS.txt") -Encoding ASCII

$buildManifest = [ordered]@{
  agentVersion = $versionInfo.agentVersion
  protocolVersion = $versionInfo.protocolVersion
  gitCommit = $commit
  buildDate = $buildDate
  fileCount = $manifestEntries.Count
  installerIncluded = $false
}
Write-Utf8NoBom -Path (Join-Path $release "build-manifest.json") -Content ($buildManifest | ConvertTo-Json -Depth 8)

Write-Host ""
Write-Host "Build agent (Lot 1+2) pret: $release"
Write-Host "Aucun installateur n'est produit a ce stade (voir docs/agent-packaging.md pour le perimetre exact par lot)."
Write-Host "Pour tester: copier '$appDir' hors du depot puis lancer 'node agent/agentMain.js' (ou agent-launch-no-console.vbs, candidat sans console) depuis ce dossier."
Write-Host "Au premier lancement sans identifiants, une interface locale s'ouvre sur http://127.0.0.1:<port>/ pour l'appairage."
