#!/usr/bin/env bash
# Deploy browser-service to Railway (service "fpx-browser", project
# "stellar-creation"). Uploads ONLY what the image needs — browser-service/ and
# extension/ — with railway.json at the upload root, instead of the whole repo.
#
# Usage: ./browser-service/deploy-railway.sh            (from anywhere)
# Needs: `railway login`, and the project linked in a directory you pass as
# RAILWAY_LINK_DIR (or run it from a dir linked to stellar-creation).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude node_modules --exclude .profiles --exclude .profile "$ROOT/browser-service" "$STAGE/"
rsync -a --exclude config.js "$ROOT/extension" "$STAGE/"
cp "$ROOT/.dockerignore" "$STAGE/"
cp "$ROOT/browser-service/railway.json" "$STAGE/railway.json"
cd "${RAILWAY_LINK_DIR:-$PWD}"
railway up "$STAGE" --path-as-root --service fpx-browser --ci -m "${1:-fpx-browser deploy}"
