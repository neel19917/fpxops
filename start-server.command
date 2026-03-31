#!/bin/bash
# Double-click this file on macOS to start the FPXpress LangGraph server.
# It will install dependencies (if needed) and launch the server.

cd "$(dirname "$0")/server"

echo "========================================="
echo "  FPXpress LangGraph Server"
echo "========================================="
echo ""

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run)..."
  npm install
  echo ""
fi

echo "Starting server on http://localhost:3210 ..."
echo "Press Ctrl+C to stop."
echo ""
node index.js
