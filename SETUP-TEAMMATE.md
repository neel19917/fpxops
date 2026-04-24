# FPXpress — Teammate Setup (localhost testing)

Run the API server on your own machine. The Chrome extension talks to it over
`http://localhost:3210`. All shipment + AI data is written to the shared
Supabase — so what you scrape is visible in the team dashboard.

## One-time setup (5 min)

1. **Install Node.js 20+** from https://nodejs.org (pick the LTS installer).
2. **Unzip FPXpress** to a permanent folder, e.g. `~/FPXpress` or `C:\FPXpress`.
3. **Check the `server/.env` file** — your admin will have pre-filled it with the
   shared Anthropic + Supabase keys. If it's missing:
   - Copy `server/.env.example` to `server/.env`
   - Ask your admin for the values.
4. **Check `config.js`** — it should have your personal FPX API key pre-set:
   ```js
   const FPX_API_URL = "http://localhost:3210";
   const FPX_API_KEY = "fpx_live_...";
   ```
   If it's missing or shows `YOUR_FPX_API_KEY_HERE`, ask your admin for a key.

### Load the Chrome extension
1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** → pick the FPXpress folder
4. Pin the extension to your toolbar
5. **Copy your extension ID** — the long string under "FPXpress" (looks like
   `abcdefghijklmnopqrstuvwxyzabcdef`). You'll paste it in the next step.

### Register the "Start Server" button (one-time)
- **Mac**: double-click `install-native-host.command`. If macOS blocks it,
  right-click → Open → Open. Paste the extension ID when it asks.
- **Windows**: double-click `install-native-host.bat`. Paste the extension ID.

This installs a tiny helper so the extension's **Start Server** button can
launch the Node server on your machine. You only do this once.

### Fallback: start the server from the terminal
If you skip the native-host install, you can still run the server manually:
- **Mac**: double-click `start-server.command`
- **Windows**: double-click `start-server.bat`

Keep that terminal window open. With the native host installed, you don't
need to.

## Daily use

1. Open the FreightPOP app and click the FPXpress extension icon.
2. In the side panel, click **Start Server** (green button). Wait ~2s — badge
   flips to 🟢 API v2.0.0.
3. Run a refresh / GP audit / invoice audit. Results appear in the shared
   dashboard within seconds.
4. When you're done for the day, click **Stop** (or leave it running — it
   uses negligible resources).

### Verify it works
Click the FPXpress icon. You should see:
- 🟢 **API Key OK**
- 🟢 **API v2.0.0 (up Xs)**

If either shows red, either the server isn't running or your API key is wrong.

### Use it
Navigate to https://app.freightpop.com, click the extension icon, open the
side panel, and run a refresh / GP audit / invoice audit like usual. Results
will appear in the shared dashboard within seconds.

## Troubleshooting

| Problem | Fix |
|---|---|
| "node is not installed" on start | Install from https://nodejs.org, then try again |
| "API offline" in the extension | Terminal window closed — run `start-server.command` again |
| "401 Invalid or revoked API key" | Your key was revoked. Ask admin for a new one and update `config.js` |
| Port 3210 already in use | Edit `server/.env` → set `PORT=3211` (or another) and update `config.js` `FPX_API_URL` to match |
| macOS: "can't be opened because it's from an unidentified developer" | Right-click `start-server.command` → Open → Open |
| Start Server button shows "native host isn't installed" | Run `install-native-host.command` / `.bat` once, paste the extension ID, then reload the extension |

## Where your data goes

- **Shipments** → shared Supabase table `fpx_shipments`
- **AI analyses** → shared Supabase table `fpx_ai_analyses` (every Claude call
  is logged with tokens + cost)
- **GP / Invoice audits** → shared Supabase tables `fpx_gp_audits`, `fpx_invoice_audits`

Everyone on the team sees the same dashboard.
