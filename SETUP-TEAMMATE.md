# FPXpress — Teammate Setup

The FPX API runs in the cloud on Railway. You just need to install the Chrome
extension and paste a key — no server to run, no terminal to keep open.

## One-time setup (2 min)

1. **Unzip FPXpress** to a permanent folder (e.g. `~/FPXpress` or `C:\FPXpress`).

2. **Open `config.js`** in any text editor. It should already have:
   ```js
   const FPX_API_URL = "https://YOUR-APP.up.railway.app";
   const FPX_API_KEY = "fpx_live_...";
   ```
   If the key is still `YOUR_FPX_API_KEY_HERE`, ask your admin for a key.

3. **Load the extension**
   - Open `chrome://extensions`
   - Toggle **Developer mode** (top-right)
   - Click **Load unpacked** → pick the FPXpress folder
   - Pin the extension to your toolbar

4. **Verify** — click the FPXpress icon. You should see:
   - 🟢 **API Key OK**
   - 🟢 **API v2.0.0 (up Xs)**

If the badge is red: click it → paste the URL and key → Save.

## Daily use

Navigate to https://app.freightpop.com, open the FPXpress side panel, run a
refresh / GP audit / invoice audit as usual. Data and AI analyses are written
to the shared Supabase and show up in the team dashboard within seconds.

## Troubleshooting

| Problem | Fix |
|---|---|
| 🔴 No API Key | Click the badge, paste the URL + key your admin gave you |
| "401 Invalid or revoked API key" | Your key was revoked. Ask admin for a new one |
| API badge shows Offline | Railway is down or the URL is wrong — ask your admin |

## Where your data goes

- **Shipments** → shared Supabase table `fpx_shipments`
- **AI analyses** → shared Supabase table `fpx_ai_analyses` (every Claude call
  is logged with tokens + cost)
- **GP / Invoice audits** → shared Supabase tables `fpx_gp_audits`, `fpx_invoice_audits`

Everyone on the team sees the same dashboard.

---

## Optional: running the server locally (advanced)

You don't need this for normal use — the cloud API handles everything. But if
you need to debug or develop against the server, you can run it on your own
machine:

1. Install Node.js 20+ from https://nodejs.org
2. Register the native host (one-time): double-click
   `install-native-host.command` (Mac) or `install-native-host.bat` (Windows)
   and paste your extension ID when asked.
3. Update `config.js` to point at `http://localhost:3210`.
4. Open the side panel → click **Start Server**.
