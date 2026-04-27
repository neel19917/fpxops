#!/bin/bash
# Packages the current folder into a zip your teammates can unzip and run.
# Excludes node_modules, git metadata, dist, build artifacts, and .DS_Store.
# The extension is configured per-user via the popup (URL + API key) — there's
# no config.js to bake in. server/.env is only needed if the teammate intends
# to run the API server locally; the cloud Railway deployment is the default.

set -e
cd "$(dirname "$0")"

OUT="FPXpress-$(date +%Y-%m-%d).zip"
echo "📦 Packaging into $OUT"

rm -f "$OUT"
zip -rq "$OUT" . \
  -x "*/node_modules/*" \
  -x "node_modules/*" \
  -x ".git/*" \
  -x "dashboard/dist/*" \
  -x "*.tsbuildinfo" \
  -x "*.DS_Store" \
  -x "*.xlsx" \
  -x "*.xls" \
  -x "$OUT"

echo "✓ $OUT ready — share with your teammate."
echo "  They unzip, load extension/ via chrome://extensions (Developer mode → Load unpacked),"
echo "  then click the FPXpress icon to paste their API URL + key."
