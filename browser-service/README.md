# fpx-browser — hosted FreightPOP with the extension built in

Removes the need for each rep to install the FPXpress Chrome extension.
Each dashboard user gets **their own server-side Chromium** (own profile, own
cookies) running the **unmodified `extension/`**. Every rep logs in to
FreightPOP with **their own account** — logins are never shared — and their
browser is streamed into the dashboard's FreightPOP pane.

```
Dashboard (canvas) ──WebSocket (Supabase JWT)──► fpx-browser ──► Chromium + extension ──► app.freightpop.com
      ▲ JPEG screencast frames                     │ CDP input / Runtime.evaluate         │
      └──────────── mouse / keys / paste ──────────┘                                      └─► Railway API (uploads, as today)
```

| Piece | How |
|---|---|
| Live view | CDP `Page.startScreencast` per tab → binary WS frames → `<canvas>` (`dashboard/src/components/HostedFreightPop.tsx`) |
| Input | Mouse/wheel/keys → `Input.dispatch*Event`; paste → `Input.insertText` |
| Filter / Open tracking | `Runtime.evaluate("fpxBridgeHandle(...)")` in the content script's isolated world (`content.js`), no iframe/postMessage needed |
| Per-user browsers | One Chromium per user, profile at `/data/profiles/<sha256(email)>`; a user's extra dashboard tabs open extra windows in *their* browser. Started on demand, closed after `IDLE_CLOSE_MIN` idle; cookies (incl. session-only) snapshotted and restored so reps don't re-login after idle close |
| Rescrape queue | `SCRAPE_WORKER=1` claims `fpx_scrape_requests` and runs Refresh All **in the requester's own browser/login**; fails with a note if that rep never logged in |
| Worker lanes | Two independent job slots in `src/worker.js`, each one job at a time, both can run at once (also for the same user: same Chromium and login, one window per job). **scrape**: Refresh All, manual and scheduled (claims with `only=scrape`). **invoicing**: `erp_audit`, `get_invoice`, `approval_check` (claims with `only=invoicing`). Each has its own log, Stop/Pause and live view: `POST /scrape/stop\|pause\|resume` and `GET /scrape/log` take `?lane=scrape\|invoicing` (default `scrape`); the read-only view takes `target: "scrape"` or `"invoicing"`. `/stats` → `worker` is the scrape lane, `worker.invoicing` the other. `/health` → `scrapeWorker` and `invoicingWorker` (`busy`/`idle`): deploy only when **both** are idle |
| Auth | First WS message `{type:"auth", token}`; verified against the API (`GET /api/ops/rescrape`, enabled users only) + `Origin` allow-list |

## Run locally (Docker)

```bash
# from the repo root
docker build -f browser-service/Dockerfile -t fpx-browser .
docker volume create fpx-browser-data
docker run -d --name fpx-browser -p 8080:8080 --shm-size=1g \
  -v fpx-browser-data:/data \
  -e FPX_API_URL=https://fpxtrackingchromeextension-production.up.railway.app \
  -e FPX_API_KEY=fpx_live_...            `# read,write key the hosted extension uploads with (tagged with each user's email)` \
  -e ALLOWED_ORIGINS=http://localhost:5173,https://fpxpress.netlify.app \
  fpx-browser
curl localhost:8080/health
```

Dashboard: add `VITE_FPX_BROWSER_URL=http://localhost:8080` to `dashboard/.env.local`
and `npm run dev`. The FreightPOP pane switches from iframe to the hosted view
and the pill reads **Hosted ok**. Leave the var unset to keep the old
iframe + extension path.

First run per rep: log in to FreightPOP with **your own account** in the hosted
view. It persists in your profile on the `/data` volume; nobody else's browser
can see it.

`BROWSER_DEV_NO_AUTH=1` skips JWT/origin checks — local testing only.

## Env

| Var | Default | |
|---|---|---|
| `FPX_API_URL` | prod Railway | JWT verification + extension upload target |
| `FPX_API_KEY` | — | Seeded into the extension; needed for uploads and the scrape worker |
| `ALLOWED_ORIGINS` | netlify + localhost:5173 | WS `Origin` allow-list |
| `MAX_SESSIONS` | 20 | Concurrent viewer tabs, all users |
| `MAX_TABS_PER_USER` | 3 | Per person; their oldest tab is closed when exceeded |
| `MAX_BROWSERS` | 6 | Concurrent per-user Chromiums (~300 MB each); idle ones are evicted first |
| `IDLE_CLOSE_MIN` | 30 | Close a user's browser after this long with no tabs |
| `SCRAPE_WORKER` | off | `1` to consume the rescrape queue |
| `SCRAPE_POLL_MS` / `SCRAPE_TIMEOUT_MIN` | 30000 / 120 | |
| `FREIGHTPOP_START_URL` | `https://app.freightpop.com/` | Where new viewer tabs open |
| `PROFILE_ROOT` | `/data/profiles` | Mount a volume at `/data` |

## Deploy (Railway)

Live: **https://fpx-browser-production.up.railway.app** — service `fpx-browser`
in project `stellar-creation` (next to `FPXtrackingchromeextension`).

- Config as code: `browser-service/railway.json` (Dockerfile build, `/health`
  check, restart on failure, **1 replica** — profiles live on one volume).
- Volume `fpx-browser-volume` mounted at `/data`; the service reads
  `RAILWAY_VOLUME_MOUNT_PATH` for the profile root. `RAILWAY_RUN_UID=0` so the
  container can write to the (root-owned) volume.
- Variables: `FPX_API_URL`, `FPX_API_KEY` (key "fpx-browser hosted (railway)"),
  `SCRAPE_WORKER=1`, `ALLOWED_ORIGINS`, `MAX_BROWSERS=4`, `MAX_SESSIONS=20`,
  `MAX_TABS_PER_USER=3`, `IDLE_CLOSE_MIN=30`.
- Redeploy: `RAILWAY_LINK_DIR=<dir linked to stellar-creation> ./browser-service/deploy-railway.sh "message"`
  — uploads only `browser-service/` + `extension/`.
- **Only one scrape worker may run** against the shared queue: keep
  `SCRAPE_WORKER` off on any local Docker copy.

Dashboard: set `VITE_FPX_BROWSER_URL` to the URL above (Netlify env for prod,
`dashboard/.env.local` for local dev).

## Plan / status

1. ✅ **MVP (this):** Docker image, per-user screencast tabs, input, paste,
   filter/open-tracking bridge, auth, rescrape worker, dashboard switch.
   Verified locally: per-user Chromium isolation (separate processes/profiles), idle close + cookie snapshot, extension SW loads, content-script bridge answers
   (`fpxPong`), click+type into FreightPOP login, two concurrent viewers,
   resize, origin/JWT rejection.
2. ⏭ Log in with your own account, verify `fpxFilter`/`fpxOpenTracking` on the
   real grid, run one queued Refresh All end-to-end with `SCRAPE_WORKER=1`.
3. ⏭ Deploy to Railway; check whether FreightPOP MFA/bot checks object to a
   datacenter IP (fallback: Fly.io region / static egress IP).
4. ⏭ Hardening: pause screencast while the pane is hidden, session idle
   timeout, copy-out of remote clipboard, file download/upload passthrough,
   "selected" rescrape scope, scheduled Refresh All, alert when a rep's
   session hits `/login`.
5. ⏭ Retire the extension path: drop iframe/third-party-cookie code, `/install`
   page, and `ExtLogin` relay once hosted mode is the default.

## Known MVP limitations

- `scope="selected"` rescrapes run a full Refresh All.
- Copying text *out* of the remote page doesn't reach your local clipboard.
- File uploads/downloads inside FreightPOP aren't passed through yet.
- Uploads use the service API key (tagged with the rep's email as
  `fpxUserName`), not each rep's personal key.
- Profiles hold live FreightPOP sessions — treat the `/data` volume as sensitive.
