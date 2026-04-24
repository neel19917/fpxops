#!/bin/bash
# Registers the FPXpress native messaging host with Chrome on macOS.
# Run this ONCE after you've loaded the extension. After this, the "Start Server"
# button in the extension's side panel will launch the API server for you.
#
# Usage:
#   ./install-native-host.command          # will prompt for extension ID
#   ./install-native-host.command <EXTID>  # or pass it directly

set -e
cd "$(dirname "$0")"

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "════════════════════════════════════════════════════════════"
  echo "  FPXpress — Native host installer (one-time setup)"
  echo "════════════════════════════════════════════════════════════"
  echo
  echo "Find your extension ID:"
  echo "  1. Open  chrome://extensions  in Chrome"
  echo "  2. Turn on Developer Mode (top-right)"
  echo "  3. Find 'FPXpress' and copy the ID under its name"
  echo "     (long string of letters like 'abcdef...xyz')"
  echo
  read -p "Paste the extension ID: " EXT_ID
fi

if [ -z "$EXT_ID" ]; then
  echo "❌ No extension ID. Aborting."
  read -p "Press Enter to close."
  exit 1
fi

# Locate node.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for p in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$p" ]; then NODE_BIN="$p"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "❌ Could not find node. Install from https://nodejs.org and retry."
  read -p "Press Enter to close."
  exit 1
fi
echo "  node: $NODE_BIN"

# First-time npm install so the server can actually start.
if [ ! -d server/node_modules ]; then
  echo "📦 Installing server dependencies (one-time)…"
  (cd server && "$NODE_BIN" "$(dirname "$NODE_BIN")/npm" install) || (cd server && npm install)
fi

# Write the launcher shim that Chrome will actually call.
LAUNCHER="$(pwd)/native-host/host-launcher.sh"
cat > "$LAUNCHER" <<EOF
#!/bin/bash
exec "$NODE_BIN" "$(pwd)/native-host/host.js"
EOF
chmod +x "$LAUNCHER"
chmod +x "$(pwd)/native-host/host.js"

# Write Chrome's native messaging manifest.
HOST_NAME="com.fpxpress.server"
for BROWSER_DIR in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
do
  mkdir -p "$BROWSER_DIR"
  cat > "$BROWSER_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "FPXpress API server launcher",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
done

echo
echo "✅ Installed."
echo
echo "Next steps:"
echo "  1. Go to chrome://extensions and click the reload ↻ on FPXpress."
echo "  2. Open the FPXpress side panel."
echo "  3. Click 'Start Server' — the API will boot in the background."
echo
read -p "Press Enter to close."
