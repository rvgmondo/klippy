#!/usr/bin/env bash
# Klippy v2 - build the cPanel deploy bundle into deploy/.
# Produces:
#   deploy/klippy-web.zip   - static frontend; unzip INTO the subdomain docroot
#   deploy/klippy-api.zip   - Node API; unzip into the app folder cPanel creates
#   deploy/schema.sql       - import once via phpMyAdmin
# Run from repo root:  bash scripts/make-deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/c/CC/tools/node:$PATH"

echo "[1/4] Building API (TypeScript -> dist/)..."
(cd api && npm run -s build)

echo "[2/4] Building web app (Vite production build)..."
(cd web && npm run -s build)

echo "[3/4] Regenerating deploy/schema.sql from the Drizzle migration..."
mkdir -p deploy
sed 's/--> statement-breakpoint//' api/drizzle/0000_*.sql > deploy/schema.sql

echo "[4/4] Zipping (Windows bsdtar)..."
ZIP=/c/Windows/System32/tar.exe
rm -f deploy/klippy-web.zip deploy/klippy-api.zip
(cd web/dist && "$ZIP" -a -cf ../../deploy/klippy-web.zip -- *)
(cd api && "$ZIP" -a -cf ../deploy/klippy-api.zip app.js package.json package-lock.json dist drizzle)

echo
echo "Done. Bundle contents:"
ls -la deploy/
echo
echo "Next: follow deploy/DEPLOY.md"
