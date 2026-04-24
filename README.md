# FPXpress — Shipment Tracking · AI Audits · Dashboard

Internal tool for the FreightPOP freight support team. Three pieces:

| Piece | What it is |
|---|---|
| `./` (extension) | Chrome MV3 extension that scrapes FreightPOP and pushes data through the API |
| `./server/` | Node/Express API deployed to **Railway**. Wraps Anthropic, writes to Supabase, issues API keys |
| `./dashboard/` | Vite + React + TypeScript + Tailwind dashboard (reads everything through the API) |

```
Chrome extension (x-api-key) ─┐
                               ├──► Railway API ──► Anthropic (AI)
TS Dashboard   (Supabase JWT) ─┘                 └──► Supabase (shipments, AI log, audits, users, share links)
```

- Extension uses a long-lived `fpx_live_…` **API key** minted in the dashboard.
- Dashboard users sign in with **Microsoft** via Supabase Auth; the JWT gates every API call. Access is manually granted per-user.
- AI calls are logged to `fpx_ai_analyses` (tokens, cost, duration). No Anthropic key on the client.
- Shareable URLs (`/share/:token`) let you send a single shipment or audit to someone without an account; every view is logged.

---

## Setup

The API server is deployed to **Railway**. The extension and dashboard both
point at a single URL (`FPX_API_URL`). For teammates, this is the only path —
no local server to run.

> **Handing this to a teammate?** Send them the folder + [SETUP-TEAMMATE.md](./SETUP-TEAMMATE.md).
> They load the extension, paste the API key, done.

### 1 · Deploy the server to Railway

```bash
cd server
cp .env.example .env      # fill in values for local dev only
```

Create a Railway project from `server/`. In **Variables**, set:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `SUPABASE_URL` | `https://vvplkjgymahavqrejmgm.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase project settings (service role — server-only) |
| `CORS_ORIGINS` | `chrome-extension://*,http://localhost:5173,https://your-dashboard.example` |
| `FPX_BOOTSTRAP_ADMIN_KEY` *(optional)* | plaintext like `fpx_live_BOOTSTRAP...` — on startup the server inserts this as an admin key. Useful for first boot; remove after. |

Railway deploys automatically from Git. Health check: `GET /health`.

### 2 · Issue your first API key

If you set `FPX_BOOTSTRAP_ADMIN_KEY`, you already have one. Otherwise, run once locally:

```bash
cd server
npm install
npm run create-key -- "bootstrap" read,write,admin
```

Save the `fpx_live_…` plaintext it prints — it's shown once.

Use that admin key in the dashboard's API Keys tab to mint lower-scoped keys (`read,write` for the extension, `read` for viewers).

### 3 · Configure the Chrome extension

```bash
cp config.example.js config.js
# edit config.js → set FPX_API_URL and FPX_API_KEY (a read,write key)
```

At `chrome://extensions` → Developer mode → **Load unpacked** → select this folder.

You can also set the URL + key at runtime from the popup (click the extension icon → Edit API Key) — runtime settings override `config.js`.

### 4 · Run the dashboard

Local dev:
```bash
cd dashboard
cp .env.example .env.local   # optional: pre-fill VITE_FPX_API_URL
npm install
npm run dev                  # http://localhost:5173
```

Production build:
```bash
npm run build                # outputs dashboard/dist — host anywhere
```

On first load the dashboard asks for the Railway URL + API key; they're saved to `localStorage` on that browser. Sign out from the header to clear.

---

## How it's wired

### Supabase tables (all prefixed `fpx_`)

| Table | Purpose |
|---|---|
| `fpx_shipments` | One row per scraped shipment. `raw_data` JSONB preserves the full scrape |
| `fpx_ai_analyses` | One row per Claude call (prompt, response, tokens, cost, duration, extracted issue/recommendation/action) |
| `fpx_gp_audits` + `fpx_gp_audit_rows` | GP audit runs and their per-row detail |
| `fpx_invoice_audits` + `fpx_invoice_audit_rows` | Invoice audit runs and per-row detail |
| `fpx_api_keys` | `sha256`-hashed keys; plaintext only shown once at creation. Revoke with `DELETE /api-keys/:id` |

RLS: all `fpx_*` tables are locked — only the server's **service role** can read/write. Clients go through the API.

### Key endpoints

All `/api/*` routes require `x-api-key`. Admin routes under `/api-keys/*` require the `admin` scope.

```
GET  /health
GET  /api/shipments?customer=&action=&q=&limit=
GET  /api/shipments/:id
POST /api/shipments          { shipment } | { shipments: [] }
GET  /api/analyses?kind=&tracking_number=&limit=
POST /api/analyze/shipment   { shipment, system?, template? }
POST /api/analyze/summary    { payload, system?, template? }
POST /api/analyze/gp-summary | /gp-row | /invoice-summary | /invoice-row | /vision
GET  /api/audits/gp | /api/audits/gp/:id
POST /api/audits/gp          { run, rows: [] }
GET  /api/audits/invoice | /api/audits/invoice/:id
POST /api/audits/invoice     { run, rows: [] }

# Admin (admin scope required)
GET    /api-keys
POST   /api-keys   { name, scopes?: ['read','write','admin'] }  → plaintext returned once
DELETE /api-keys/:id   (soft-revoke)
```

### Extension modes

| Mode | What it does |
|---|---|
| **Refresh All Shipments** | Opens each shipment modal, scrapes fields, optionally runs AI per-shipment. Bulk-pushes all rows + logs every AI call to Supabase through the API |
| **GP Audit** | Scrapes transaction history, computes GP% + outliers, optional AI exec summary |
| **Invoice Audit** | Matches a carrier-bill XLSX against shipment costs; optional AI summary |

---

## Running the server locally (advanced / debugging)

Not required for normal use — Railway handles everything. Only useful for
developing the server itself:

```bash
cd server
cp .env.example .env          # fill in keys
npm install
npm start                     # listens on http://localhost:3210 by default
```

Mint an admin key: `npm run create-key -- "admin" read,write,admin`.
Point `config.js` at `http://localhost:3210` and reload the extension.

The extension also supports a one-click Start/Stop button for the local
server — register Chrome's native messaging host once with
`install-native-host.command` (Mac) or `install-native-host.bat` (Windows).
The side panel's "Local API server" card will appear whenever `FPX_API_URL`
points at localhost.

---

## Security notes

- Anthropic key lives on the server only (Railway env var). Revoking an extension's API key in the dashboard does not revoke Anthropic — it just stops that client from calling.
- API keys are sha256-hashed at rest. The plaintext is shown **once** when you create it; it is never retrievable after.
- Revoking a key is immediate (next request fails with 401). Revocation is soft (audit trail preserved).
- CORS is allowlisted (`CORS_ORIGINS`). Set it to just the origins that need to talk to the API.

---

## Project layout

```
/                 Chrome extension (background.js, content.js, popup, sidepanel, manifest)
/config.js        FPX_API_URL + FPX_API_KEY (gitignored)
/server/          Node API (Railway target)
/server/routes/   REST handlers
/server/lib/      Supabase client, Anthropic wrapper, auth middleware
/dashboard/       Vite + React + TS + Tailwind dashboard
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Dashboard "Connecting…" never completes | Check that the Railway URL is correct, and that the dashboard origin is in `CORS_ORIGINS` on the server |
| 401 Invalid or revoked API key | Key is wrong, revoked, or missing the right scope. Issue a new one from the dashboard API Keys tab |
| 403 Requires 'admin' scope | Create-key / list-keys / revoke-key all need `admin`. Mint an admin key from an existing admin session or via `npm run create-key -- "x" read,write,admin` |
| AI analyses not appearing | Check the extension's FPX_API_URL + FPX_API_KEY in the popup; check the server logs on Railway for Supabase errors |
| Extension modes still show "Server offline" badge | That's the Railway API health check. Check network → FPX_API_URL + `/health` |

## Updating

New zip:
1. Back up your `config.js` (it has your key).
2. Delete the old folder contents.
3. Unzip the new version.
4. Restore your `config.js`.
5. `chrome://extensions` → reload the extension.
