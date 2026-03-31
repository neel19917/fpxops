# FPXpress Tracking Refresh

Chrome extension + LangGraph server for automated shipment analysis on the FreightPOP dashboard.

## Quick Start (One-Click)

### Step 1: Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** and select this folder (`FPX-RefreshAllShipments`)
4. Note the **extension ID** shown under the extension name (you'll need it in Step 2)

### Step 2: Enable auto-start (one-time setup)

Double-click `install-native-host.command` and paste your extension ID when prompted. This registers a native helper so the extension can start/stop the server automatically.

### Step 3: Use it

1. Navigate to `app.freightpop.com`
2. Click the extension icon, then **Open Side Panel**
3. Click **Start** in the server control bar — the server launches automatically
4. Set your filter and click **Start** to begin scraping

The side panel stays open while you work. The server starts and stops from inside the extension — no terminal needed.

### Alternative: Manual server start

If you prefer not to use auto-start, double-click `start-server.command` (macOS) or `start-server.bat` (Windows).

## How It Works

1. **Side Panel** — Persistent control panel next to FreightPOP. Shows progress bar, server status, and AI summary.
2. **Content Script** — Clicks through each shipment, opens modals, scrapes data. Checkpoints every 25 rows.
3. **LangGraph Server** — Classifies shipments (routine/ambiguous/critical), sends only non-routine ones to Claude, retries parse failures, generates executive summary.
4. **Batch Processing** — Sends shipments to the server in chunks of 25 to avoid memory issues. Handles 700+ shipments.
5. **XLSX Export** — Downloads a styled Excel workbook with Actions, Inputs, All Shipments, and Summary sheets.

If the server is offline, the extension falls back to per-shipment Anthropic API calls directly from the browser.

## Configuration

### API Key

Edit `config.js` and replace the API key:

```js
const ANTHROPIC_API_KEY = "sk-ant-api03-your-key-here";
```

The same key is in `server/.env` for the LangGraph server:

```
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
```

### Server Port

Default is `3210`. Change in `server/.env`:

```
PORT=3210
```

## Commands

```bash
npm run setup    # Install server dependencies
npm run server   # Start the LangGraph server
npm test         # Run the 21 test cases
```

## Project Structure

```
FPX-RefreshAllShipments/
├── manifest.json              # Chrome extension manifest (v3)
├── sidepanel.html/js          # Persistent side panel UI
├── popup.html/js              # Launcher popup (opens side panel)
├── background.js              # Service worker (API calls, native messaging)
├── content.js                 # DOM scraper + batch orchestrator
├── config.js                  # API key + model config (gitignored)
├── native-host/host.js        # Native messaging host (starts/stops server)
├── server/
│   ├── index.js               # Express server entry point
│   ├── graph.js               # LangGraph StateGraph definition
│   ├── nodes/                 # classify, analyze, parse, summarize
│   ├── prompts.js             # AI prompt templates
│   └── tests/graph.test.js    # 21 test cases
├── start-server.command       # macOS one-click launcher
├── start-server.bat           # Windows one-click launcher
└── install-native-host.command # Registers native host with Chrome
```

## Requirements

- Node.js 18+
- Chrome 114+ (for Side Panel API)
- Anthropic API key
