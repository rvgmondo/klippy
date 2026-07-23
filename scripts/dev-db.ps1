# Klippy v2 - local dev database (portable MariaDB, no install).
# Initializes a data dir on first run, then starts MariaDB on port 3307
# with a `klippy` database and `klippy`/`klippy` user.
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev-db.ps1
#
# Native mariadb.exe prints a benign passwordless-login warning to stderr; don't
# let PowerShell treat that as a terminating error. We check $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
$MariaDir = 'C:\CC\tools\mariadb'
$DataDir  = 'C:\CC\klippy-v2\data\mysql'
$LogFile  = 'C:\CC\klippy-v2\data\mysqld.log'
$Port     = 3307
$Bin      = Join-Path $MariaDir 'bin'

if (-not (Test-Path (Join-Path $Bin 'mariadbd.exe'))) {
  throw "MariaDB not found at $Bin. Extract the portable zip to $MariaDir first."
}

# First-run: initialize the data directory. (Windows install-db does NOT accept
# the Unix-only --auth-root-authentication-method flag; root is passwordless.)
if (-not (Test-Path (Join-Path $DataDir 'mysql'))) {
  Write-Host "Initializing data dir at $DataDir ..."
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  & (Join-Path $Bin 'mariadb-install-db.exe') "--datadir=$DataDir" | Out-Null
}

# If already running, skip starting a second server.
if (-not (Get-Process mariadbd -ErrorAction SilentlyContinue)) {
  Write-Host "Starting MariaDB on port $Port ..."
  Start-Process -FilePath (Join-Path $Bin 'mariadbd.exe') `
    -ArgumentList "--datadir=$DataDir","--port=$Port" `
    -RedirectStandardError $LogFile -RedirectStandardOutput "$LogFile.out" -WindowStyle Hidden
}

# Wait for it to accept connections.
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 700
  & (Join-Path $Bin 'mariadb.exe') "--host=127.0.0.1" "--port=$Port" "--user=root" "-e" "SELECT 1" *>$null
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
}
if (-not $ok) { throw "MariaDB did not come up on port $Port. See $LogFile" }

# Create database + app user (idempotent).
$sql = @"
CREATE DATABASE IF NOT EXISTS klippy CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'klippy'@'%' IDENTIFIED BY 'klippy';
CREATE USER IF NOT EXISTS 'klippy'@'localhost' IDENTIFIED BY 'klippy';
GRANT ALL PRIVILEGES ON klippy.* TO 'klippy'@'%';
GRANT ALL PRIVILEGES ON klippy.* TO 'klippy'@'localhost';
FLUSH PRIVILEGES;
"@
$sql | & (Join-Path $Bin 'mariadb.exe') "--host=127.0.0.1" "--port=$Port" "--user=root" 2>$null
Write-Host "MariaDB ready on 127.0.0.1:$Port  db=klippy  user=klippy  pass=klippy"
