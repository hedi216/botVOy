$ErrorActionPreference = "Stop"

Write-Host "Installation PostgreSQL 17 via Chocolatey..."
Write-Host "Ce script doit etre lance dans PowerShell en mode Administrateur."

choco install postgresql17 -y --params '/Password:SMART /Port:5432'

Write-Host "PostgreSQL installe. Relancez ensuite:"
Write-Host "npm.cmd run db:init"
