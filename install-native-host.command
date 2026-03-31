#!/bin/bash
# Double-click this file on macOS to register the Native Messaging host.
# This lets the Chrome extension start/stop the LangGraph server automatically.
# Run this ONCE after loading the extension for the first time.

set -e
cd "$(dirname "$0")"

HOST_NAME="com.fpxpress.server"
HOST_SCRIPT="$(pwd)/native-host/host.js"
NODE_PATH="$(which node)"

if [ -z "$NODE_PATH" ]; then
  echo "ERROR: Node.js not found. Install it from https://nodejs.org"
  echo "Press any key to exit."
  read -n1
  exit 1
fi

# Ask for the extension ID (visible in chrome://extensions)
echo "========================================="
echo "  FPXpress Native Host Installer"
echo "========================================="
echo ""
echo "Open chrome://extensions, find 'FPXpress Tracking Refresh',"
echo "and copy the extension ID (a 32-character string like 'abcdef...')."
echo ""
read -p "Paste your extension ID here: " EXT_ID

if [ ${#EXT_ID} -lt 20 ]; then
  echo "That doesn't look like a valid extension ID. Try again."
  read -n1
  exit 1
fi

# Create the native host manifest
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST_DIR/$HOST_NAME.json" << MANIFEST
{
  "name": "$HOST_NAME",
  "description": "FPXpress LangGraph Server Controller",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
MANIFEST

# Install server dependencies if needed
if [ ! -d "server/node_modules" ]; then
  echo ""
  echo "Installing server dependencies..."
  cd server && npm install && cd ..
fi

echo ""
echo "Done! Native host registered at:"
echo "  $MANIFEST_DIR/$HOST_NAME.json"
echo ""
echo "The extension can now start/stop the server automatically."
echo "Press any key to exit."
read -n1
