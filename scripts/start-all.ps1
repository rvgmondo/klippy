# Klippy v2 - start everything for local use.
# Starts MariaDB, then the API and web dev servers in their own windows.
#   powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
# Then open http://localhost:5173
$ErrorActionPreference = 'Continue'
$Node = 'C:\CC\tools\node'
$Root = 'C:\CC\klippy-v2'

# 1. Database
powershell -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\dev-db.ps1')

# 2. API (Fastify on :8090) in a new window
Start-Process powershell -ArgumentList @(
  '-NoExit','-Command',
  "`$env:PATH='$Node;'+`$env:PATH; Set-Location '$Root\api'; npm run dev"
)

# 3. Web (Vite on :5173) in a new window
Start-Process powershell -ArgumentList @(
  '-NoExit','-Command',
  "`$env:PATH='$Node;'+`$env:PATH; Set-Location '$Root\web'; npm run dev"
)

Write-Host ""
Write-Host "Klippy starting. Open http://localhost:5173 in your browser."
Write-Host "API: http://localhost:8090   DB: 127.0.0.1:3307"
