#!/bin/bash
# Packages the current folder into a zip your teammates can unzip and run.
# Excludes node_modules, git metadata, dist, build artifacts, and .DS_Store.
# Keeps server/.env and config.js so the teammate only has to double-click.

set -e
cd "$(dirname "$0")"

OUT="FPXpress-$(date +%Y-%m-%d).zip"
echo "📦 Packaging into $OUT"

if [ ! -f server/.env ]; then
  echo "⚠️  server/.env is missing — teammate won't be able to start the server."
  echo "   Create it from server/.env.example first."
  exit 1
fi
if [ ! -f config.js ]; then
  echo "⚠️  config.js is missing — teammate's extension won't have an API key or URL."
  echo "   Copy config.example.js to config.js and fill in the teammate's FPX_API_KEY."
  exit 1
fi

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
echo "  They unzip, then double-click start-server.command (Mac) or start-server.bat (Windows)."
