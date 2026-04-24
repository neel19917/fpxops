#!/bin/bash
# FPXpress API server launcher — macOS.
# Double-click to start. Keep the Terminal window open while you use the extension.

set -e
cd "$(dirname "$0")/server"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not installed."
  echo "   Install from https://nodejs.org (LTS version) and then try again."
  read -p "Press Enter to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "📦 First-time setup — installing dependencies…"
  npm install
fi

if [ ! -f .env ]; then
  echo "⚠️  server/.env not found. Copy .env.example to .env and fill in the values from your admin."
  cp .env.example .env
  echo "   Template written to server/.env — edit it, then double-click this file again."
  read -p "Press Enter to close."
  exit 1
fi

echo "🚀 Starting FPX API on http://localhost:${PORT:-3210}"
echo "   (keep this window open while you use the extension)"
echo
node index.js
