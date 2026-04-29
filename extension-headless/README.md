# FPXpress headless

Drive the FPXpress Chrome extension from the terminal — no toolbar clicks, no
side panel. Uses Puppeteer + `--headless=new` + a persistent profile so login
cookies survive between runs.

## How it works

The driver re-uses the unmodified extension. It launches Chrome with
`--load-extension=../extension`, finds the MV3 service worker, and dispatches
the same `chrome.tabs.sendMessage` payloads that `sidepanel.js` sends when you
click **Start**. Completion is detected by listening for the `complete` /
`gpAuditComplete` / `invoiceAuditComplete` sentinels content.js already emits.

No changes are made to the extension itself.

## Install

```bash
cd extension-headless
npm install
```

Requires Node 18+ and a system Chrome install. Override with `--chrome <path>`
or `CHROME_PATH=...` if your Chrome lives somewhere unusual.

## First-time login (once per profile)

```bash
node run.js --login
```

A visible Chrome window opens at `app.freightpop.com`. Sign in, clear MFA, then
close the window. The session lives in `./.chrome-profile/` and persists
across headless runs.

Re-run this whenever runs start failing with `Redirected to /Login`.

## Seed API credentials

```bash
FPX_API_KEY=fpx_live_... \
FPX_API_URL=https://your-fpx.up.railway.app \
FPX_USER="you@freightpop.com" \
node run.js --seed-key
```

This writes `fpxApiKey` / `fpxApiUrl` / `fpxUserName` into the extension's
`chrome.storage.local` (same path as the popup's "Edit API Key" form). You can
also pass the same values on subsequent runs and they'll be re-seeded each
time.

## Run a scrape

### Refresh All Shipments

```bash
node run.js --mode refreshAll
# optional: server-side grid filter
node run.js --mode refreshAll --filter-col PaymentStatus --filter-val Unpaid
```

### GP Audit

```bash
node run.js --mode gpAudit \
  --from-date 2026-04-01 --to-date 2026-04-28 \
  --shipment-type All
```

### Invoice Audit

```bash
node run.js --mode invoiceAudit \
  --bill ./carrier-bill.xlsx \
  --from-date 2026-04-01 --to-date 2026-04-28
```

The XLSX is parsed in Node (same logic as `sidepanel.js`'s `parseInvoiceFile`)
— don't try to drive an `<input type=file>` headlessly.

### Common flags

| Flag | Purpose |
|---|---|
| `--headed` | Show the browser window (debugging) |
| `--chrome <path>` | Override Chrome binary |
| `--timeout <minutes>` | Hard timeout for the run (default 30) |

## Cron example

```cron
# Refresh unpaid shipments every hour, on the hour
0 * * * * cd /path/to/FPX-RefreshAllShipments/extension-headless && \
  FPX_API_KEY=... FPX_API_URL=... FPX_USER="cron@freightpop.com" \
  node run.js --mode refreshAll --filter-col PaymentStatus --filter-val Unpaid \
  >> /var/log/fpx-refresh.log 2>&1
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Redirected to /Login — session expired` | Re-run `node run.js --login` |
| `Could not locate Chrome` | Pass `--chrome /path/to/Chrome` or set `CHROME_PATH` |
| Timeouts with no status output | Add `--headed` and watch what the page is doing |
| Run completes but no rows in dashboard | Check `FPX_API_KEY` / `FPX_API_URL` are correct — `--seed-key` again |
| Cloudflare or bot challenge | `headless=new` exposes a less-obvious UA than legacy headless, but if FreightPOP starts gating fall back to `--headed` (with `--window-position=-2000,-2000` on Mac/Win, or Xvfb on Linux) |
