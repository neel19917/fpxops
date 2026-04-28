# FPXpress — In Flight & Outstanding

Living checklist of feature work in progress + what's pending. Update as items
land or scope shifts.

## Done

### Infra & Auth
- [x] Microsoft / Azure OAuth via Supabase (dashboard sign-in)
- [x] `fpx_user_profiles` with admin/member/viewer roles + `enabled` gate
- [x] Pending-approval screen + admin promotion flow
- [x] Supabase RLS hardening: `security_invoker` on `fpx_shipments_latest`,
  pinned `search_path` on trigger functions, EXECUTE revoked from anon /
  authenticated / public, deny-all on legacy `public.shipments`,
  `(select auth.uid())` initplan optimization, FK indexes on
  `fpx_ai_analyses` and `fpx_share_link_views`
- [x] Railway server hardened: explicit `0.0.0.0` bind, lazy `getModel()` for
  `ChatAnthropic` (so missing `ANTHROPIC_API_KEY` no longer crashes boot),
  `/health` reports `db:true` once `SUPABASE_SERVICE_ROLE_KEY` is set
- [x] Dual auth (`x-api-key` OR Bearer JWT); admin JWT can mint API keys
  (chicken-and-egg fix)
- [x] Supabase client uses no-op `lock` to avoid React Strict Mode "Loading…"
  hang; `AuthProvider` wraps `loadProfile` in try/finally

### Shipments / Tracking
- [x] Dedupe on `tracking_number` — server upserts via `onConflict`,
  `seen_count` auto-bumps via BEFORE UPDATE trigger, `created_at` preserved
- [x] Runner attribution — extension popup captures **Your Name**, sends as
  `x-fpx-user-name`, server stamps `fpx_shipments.created_by` on first
  insert; trigger preserves it on subsequent upserts
- [x] Customer name auto-guessed from origin address when missing
- [x] Modal scrape hardened — removed `parent.textContent` fallback that was
  engulfing event-history blobs into `signed_by` / `shipment_status`;
  server-side `cleanField()` drops full-modal blobs (3+ marker substrings)
  and label-residue strings, caps oversized values; backfilled existing rows

### Tasks
- [x] `fpx_shipment_tasks` table + RLS
- [x] `/api/tasks` CRUD; `/api/shipments/:id/tasks` list + create
- [x] Auto-assigns to shipment's `created_by` when no explicit assignee
- [x] Bulk-create endpoint (`POST /api/tasks/bulk`) — fans out one task per
  selected shipment from the Tracking page; `bulk-update` for mass status
  changes
- [x] **Auto-create task** when a shipment lands with `action_required='YES'`
  and has no open task (priority `high`, title from AI rec)
- [x] Tasks page: status filter, click-to-toggle done, delete

### Action override (AI vs manual)
- [x] Columns: `action_source ('ai'|'manual'|'none')`,
  `action_overridden_by/at`, `action_override_reason`
- [x] BUMP-SEEN trigger preserves manual overrides across upserts
- [x] `PATCH /api/shipments/:id/action` endpoint
- [x] Tracking page: **All sources / From AI / Manual override** filter
- [x] Drawer Overview: AI/Manual chip with Override modal (YES / On track /
  Clear + reason)

### Email drafts
- [x] `POST /api/shipments/:id/email-draft?audience=carrier|customer` —
  Claude generates subject + body
- [x] Drawer Email tab: "Email carrier" / "Email customer" buttons → modal
  with copy + mailto links
- [x] Prompts updated so FPX is identified as **the broker** (not generic);
  emails sign as "FPX Operations"
- [x] Cost recorded per draft (~$0.0012–$0.0016/draft on Haiku)

### Audit log
- [x] `fpx_audit_log` table + admin-read RLS
- [x] `lib/audit.js#logAudit()` — fire-and-forget; never throws
- [x] Wired into shipment bulk_create + override, task create/update/delete
  /bulk_create/bulk_update, auto_task hook
- [x] `GET /api/audit-log` admin-only with entity / action / actor filters
- [x] Admin **Audit** tab with expandable before/after/metadata per entry

### Drawer
- [x] Tabbed nav: Overview · Tasks · Email · Drafts · Analysis · Raw
- [x] **Drafts tab**: parses email-draft JSON, shows subject + body with
  copy / mailto, no more raw JSON dumps
- [x] **Analysis tab**: structured issue + recommendation rendering, model
  + cost + tokens footer, no raw JSON
- [x] AI Analyses page → shipment drawer deep-linking via `NavCtx`

### Feedback
- [x] `fpx_feedback` table + RLS (own + admin-all)
- [x] `/api/feedback` GET / POST / PATCH (admin triage)
- [x] Feedback tab: side-by-side submit form + list with admin status
  dropdowns

### Extension scraper
- [x] Forced per-row AI mode (batch mode bypassed `fpx_ai_analyses`
  logging — root cause of "$0 cost" issue). Per-row hits
  `/api/analyze/shipment` which logs every call.

---

## In Progress

(none — last batch landed)

---

## Done (latest)

### Extension is scrape-only; analysis lives in the dashboard

**Tracking flow** — server-driven analysis on upload
- [x] `analyzeExistingShipment(row, { reqContext })` helper in
  `server/routes/analyze.js` — runs Claude on a persisted row, patches
  `ai_issue` / `ai_recommendation` / `action_required` / `last_analyzed_at`
  (+ `action_target` / `action_confidence`), respects manual overrides
- [x] `POST /api/shipments` upsert handler strips null AI fields from the
  payload (so re-scrapes don't blow away analysis), then runs
  `autoAnalyzeUpserted` in the background (concurrency-capped to 4), then
  fans out auto-tasks + auto-drafts from the post-analysis snapshot
- [x] Migrations: `last_analyzed_at`, `action_target`, `action_confidence`
  on `fpx_shipments` (the latter two were referenced in code but missing
  — silent bug fix)
- [x] Extension Tracking flow stripped of all AI calls (`content.js`
  doesn't import / call `analyzeShipment` or `summarizeAll`). Status reads
  "Scraping shipments — analysis runs in the dashboard after upload."
  XLSX export still happens locally so reps have a record on disk.
- [x] **Hard-removed** the dead Tracking AI plumbing (after the GP/Invoice
  agent finished, so no merge collisions): `repairModelJson`,
  `findAnalysisObject`, `extractJsonObject`, `coerceActionRequired`,
  `stringifyField`, `normalizeAiFields`, `isClearlyOnTrackIssue`,
  `deriveActionRequired`, `scrapeFieldsFromLooseJson`,
  `applyAiResponseToRow`, `computeNeedsActionForSheet`,
  `finalizeActionSheetFlag`, `buildSummaryPayload`, `ROUTINE_STATUSES`,
  `EXCEPTION_KEYWORDS`, `shipmentNeedsAi`, `BATCH_CHUNK_SIZE`,
  `tryBatchAnalyze`, `fallbackPerRowAnalysis` are gone from `content.js`;
  `aiEnabled` / `smartGateEnabled` / `useBatchMode` module vars deleted;
  `run()` / start-message handler no longer take `aiEnabled` / `smartGate`.
  Sidepanel HTML lost the hidden `aiToggle` / `smartGateToggle` /
  `aiSummarySection` / `promptToggle` + editor blocks. Sidepanel JS lost
  `DEFAULT_PROMPTS`, the toggle persistence, the prompt editor handlers,
  and the `aiSummary` message handler.
- [x] Re-analyze button on the shipment drawer
  (`POST /api/shipments/:id/reanalyze` → `analyzeExistingShipment`);
  button has loading state, disabled while in-flight, refreshes drawer
  + table on success
- [x] Auth gate in `dashboard/src/lib/api.ts` (`getAccessTokenOrWait`)
  waits up to 2.5s for Supabase to hydrate the session before throwing
  "Not signed in." — fixes the "have to refresh multiple times" race

**GP & Invoice audits** — same pattern (delegated to a parallel agent)
- [x] `analyzeGpAuditRun(auditId, { reqContext, level })` and
  `analyzeInvoiceAuditRun(...)` helpers in `server/routes/analyze.js`.
  Settings-aware (`prompt.gp_*` / `prompt.invoice_*`), inline default
  prompts as fallbacks, persists `exec_summary` + `last_analyzed_at` on
  the run row, writes per-row `ai_notes` when `level==='full'` (capped
  to 50 rows)
- [x] `POST /api/audits/gp` and `POST /api/audits/invoice` accept an
  `ai_level` field and kick off the analyzers in the background; new
  `POST /api/audits/{gp,invoice}/:id/reanalyze` endpoints ready for
  future drawer buttons. Legacy `/api/analyze/gp-*` /
  `/api/analyze/invoice-*` routes kept for back-compat.
- [x] Migration `audit_ai_columns`:
  `fpx_gp_audits.last_analyzed_at` + `fpx_invoice_audits.last_analyzed_at`,
  `fpx_gp_audit_rows.ai_notes` + `fpx_invoice_audit_rows.ai_notes`
- [x] Extension `gpFinalize` / `invoiceFinalize` upload via
  `uploadGpAudit` / `uploadInvoiceAudit` background handlers (POST to
  the new audit endpoints). Removed the
  `gpAuditAiSummary` / `gpAuditRowReview` / `invoiceAuditAiSummary` /
  `invoiceAuditRowReview` `chrome.runtime.sendMessage` calls.
- [x] Sidepanel GP / Invoice tabs got the same banner treatment as
  Tracking; AI selects + AI summary sections + prompt editors are hidden;
  `sidepanel.js` references optional-chained.

### Routable dashboard tabs
- [x] `BrowserRouter` with per-tab paths
  (`/tracking`, `/tasks`, `/analyses`, `/audits/gp`, `/audits/invoice`,
  `/shares`, `/feedback`, `/admin/users` / `/admin/keys` / `/admin/audit`
  / `/admin/settings`); shipment drawer state in
  `/tracking/:id/:section` so deep-links + browser back/forward work
- [x] Netlify SPA fallback (`/* → /index.html`) so refreshes on a deep
  link don't 404; `/share/:token` still bypasses auth
- [x] Admin probe defense — non-admins typing an `/admin/*` URL are
  redirected to `/tracking`

### Tasks → shipment drawer link
- [x] Clicking a Tasks-page row opens the shipment's drawer (matches
  AI Analyses behavior); status checkbox + delete buttons stop event
  propagation; tracking-number cell rendered as a sky-link affordance

### Branded popup
- [x] Rewrote `extension/popup.html` + `extension/popup.js` with FP
  gradient header (sky-500 → blue-600), single plain-language status
  ("Connected as <name>" / "Setup needed"), big primary "Open workspace"
  CTA, inline 2-step setup (Name + API key) with URL hidden behind
  Advanced, footer Settings cog, friendly validation, Enter/Escape
  keyboard support

---

## Done (earlier)

### FreightPOP grid column parity
- [x] Migration `freightpop_grid_columns` — added `company_name`,
  `shipment_date`, `tracking_comments`, `shipper_spot_quote`,
  `pickup_tendered`, `last_modified_at`, `updated_via`, `original_eta`,
  `order_number`, `reference_one..six`, `ready_time`, `cut_off_time`,
  `appointment_set`, `appointment_date`, `required_arrival_date`,
  `spot_quote_fulfilled_by`
- [x] `mapShipment` reads all 22 new columns with multi-key fallbacks
  (`Order Number` / `OrderNumber` / `Order #`, `Reference 1` / `Ref1` /
  `REFERENCE 1`, etc.); `toBool` helper for `appointment_set`
- [x] **17-case test suite** for `mapShipment` + helpers
  (`server/tests/shipments.test.js`); full server suite 50/50
- [x] Extension scraper merges Kendo grid rows into per-shipment scrape:
  one prefetch via `inject-kendo.js`, keyed by tracking number; modal
  data wins for shared keys (`fetchKendoRowMap` + `mergeKendoRow` in
  `extension/content.js`)
- [x] Dashboard column registry (`lib/shipmentColumns.tsx`) — single
  source of truth, drives the Tracking table thead/tbody dynamically
- [x] Column selector popover with checkbox toggles, drag-to-reorder,
  Reset to defaults, persisted in localStorage (`fpx.shipmentColumns.v1`,
  forward-compatible with registry growth/shrinkage)
- [x] Tracking table renders new columns when toggled on

### Tracking tab pill nav (FreightPOP-style)
- [x] Replaced KPI cards with TOTAL (gray) / BOOKED (blue) /
  IN TRANSIT (blue) / ISSUES (blue) / OUT FOR DELIVERY (green) pills
- [x] Click-to-filter, mutually exclusive, click-again to clear
- [x] Counts derived from `shipment_status` regex matchers +
  `action_required` for ISSUES; single `shipmentMatchesPill` predicate
  drives both the count and the filter so they can't drift

---

## Pending

### Microsoft sign-in inside the Chrome extension
- Currently extension uses API keys only.
- Needs: `chrome.identity.launchWebAuthFlow` with Supabase OAuth URL,
  parse tokens from chromiumapp.org callback, store in `chrome.storage`,
  add Bearer header preference in `callApi`. Refresh handling deferred.
- Operator step: add `https://<extension-id>.chromiumapp.org/` to
  Supabase Auth → URL Configuration → Redirect URLs (extension ID is
  per-install for unpacked; stable once published to Web Store).

### Cleaner extension sidepanel UI (partial — finish as needed)
- [x] Tracking / GP / Invoice tabs: AI controls + prompt editors removed;
  banners point reps to the dashboard
- [ ] Hide the **Local API server** card unless URL is `localhost`
- [ ] FP-branded header on the side panel (matches the new popup)
- [ ] Tighten paddings / font sizes; make Start/Stop visually dominant

### Dashboard surfacing for new GP / Invoice AI output
- [ ] Render `ai_notes` on per-row outlier / discrepancy lists in the
  GP Audits + Invoice Audits drawer / detail views
- [ ] Re-analyze button on the GP / Invoice audit run pages
  (endpoints already wired: `POST /api/audits/{gp,invoice}/:id/reanalyze`)
- [ ] Seed `prompt.gp_system` / `prompt.gp_exec_summary` /
  `prompt.gp_row_review` / `prompt.invoice_system` /
  `prompt.invoice_exec_summary` / `prompt.invoice_row_review` in
  `fpx_settings` so admins can edit them from the Settings page
  (helpers fall back to inline defaults today, which is fine but
  not editable)

### Other
- [ ] Verify dedupe with a second extension run (smoke test)
- [ ] Backfill `created_by` on the existing 11 shipments (currently null —
  they were scraped before the runner-name change)

---

## Netlify deploy — dashboard

Build settings live in `dashboard/netlify.toml` (base `dashboard`,
command `npm run build`, publish `dist`, SPA fallback `/* → /index.html`).
Steps below are the things you do **once per Netlify site** (not in the
repo).

### First-time site setup

- [ ] **Connect the repo** in Netlify → "Import from Git" → pick this
  repo, branch `main` (or `beta` for the staging site).
- [ ] **Verify build settings** auto-detected from `netlify.toml`:
  - Base directory: `dashboard`
  - Build command: `npm run build`
  - Publish directory: `dashboard/dist`
  - Node version: 20 (from `[build.environment]`)
- [ ] **Set env vars** (Site settings → Environment variables). All three
  have fallbacks baked in, so a missing var won't break the build, but
  setting them explicitly avoids surprises:
  - `VITE_FPX_API_URL` →
    `https://fpxtrackingchromeextension-production.up.railway.app`
    (default falls back to `http://localhost:3210` — wrong for prod)
  - `VITE_SUPABASE_URL` → `https://vvplkjgymahavqrejmgm.supabase.co`
    (already the default; set it anyway so `git grep` finds it)
  - `VITE_SUPABASE_ANON_KEY` → Supabase project → Settings → API → anon
    public key
- [ ] **Add the Netlify origin to Supabase redirect URLs**
  (Supabase → Authentication → URL Configuration → Redirect URLs):
  - `https://<site-name>.netlify.app/**`
  - Plus the custom domain once it's set
  - Otherwise the Microsoft OAuth callback bounces to a 404 with the
    hash fragment lost.
- [ ] **Custom domain** (Site settings → Domain management → Add custom
  domain). Netlify auto-issues a Let's Encrypt cert; verify HTTPS works
  before swapping DNS.
- [ ] **Deploy contexts**: enable preview deploys for PRs (Site settings →
  Build & deploy → Deploy contexts → "Deploy Previews"). Same env vars
  apply unless overridden per-context.

### Per-deploy verification

- [ ] After first deploy, hit `https://<site>/health` — wait, that's the
  Railway server, not Netlify. The Netlify smoke is just: load the site,
  sign in with Microsoft, see Tracking populate. If sign-in fails with
  "redirect URL not allowed," go back to the Supabase redirect URLs step.
- [ ] Confirm `/share/:token` works without sign-in (open an existing
  share link in an incognito window).
- [ ] Confirm a deep link refreshes cleanly: `/tracking/<uuid>/tasks`
  reloaded should land back on the tasks tab in that shipment's drawer
  (verifies the SPA fallback is wired right).

### Common gotchas

- **Build fails with "module not found" for a `dashboard/` import**:
  base directory is wrong. It must be `dashboard`, not `/`.
- **Sign-in works locally but redirects to a blank Netlify page**:
  Supabase redirect URLs don't include the Netlify origin yet.
- **Site loads but every API call 401s**: `VITE_FPX_API_URL` is still
  the localhost default; set it to the Railway URL.
- **Force-refreshing `/admin/users` 404s**: SPA fallback redirect isn't
  applied. Check `netlify.toml` was actually deployed (it should be —
  it lives at `dashboard/netlify.toml` and Netlify reads it from there).

---

## Migrations applied (chronological)

1. `harden_fpx_shipments_latest_security_invoker`
2. `harden_fpx_trigger_functions`
3. `lock_legacy_public_shipments`
4. `optimize_rls_policies_and_fk_indexes`
5. `fpx_shipments_dedupe_by_tracking_number`
6. `preserve_shipments_created_by_on_update`
7. `create_fpx_feedback_table`
8. `tasks_and_runner_attribution`
9. `audit_log_and_action_override`
10. `freightpop_grid_columns`
11. `add_last_analyzed_at_to_fpx_shipments`
12. `add_action_target_and_confidence`
13. `audit_ai_columns` (GP/Invoice `last_analyzed_at` + `ai_notes`)

---

## Smoke-test checklist (after a deploy)

```bash
# Server health (db should be true once SUPABASE_SERVICE_ROLE_KEY is set)
curl -s https://fpxtrackingchromeextension-production.up.railway.app/health

# Auth probe (with your JWT or API key)
TOKEN="<paste>"
curl -s -H "Authorization: Bearer $TOKEN" \
  https://fpxtrackingchromeextension-production.up.railway.app/api/me
```

In the dashboard:
1. Reload extension at `chrome://extensions` → run a small filter
2. Side panel reads "Scraping shipments — analysis runs in the dashboard
   after upload." (no per-row AI narration anymore)
3. AI Analyses tab — count + total cost still grow because the **server**
   now runs Claude after upload (background, concurrency 4)
4. Open a YES-action shipment → Tasks tab should have an auto-task
   (auto-tasks now run *after* analysis, not before)
5. Email tab → Email customer → response should reference "FPX"
6. Overview → Override → set "On track" → re-run scrape; manual value
   persists
7. Overview → **Re-analyze** → Claude re-runs and updates issue /
   recommendation in place
8. Audit tab → see every change with expandable before/after,
   including new `reanalyze` action entries
9. Run a GP Audit / Invoice Audit from the side panel — extension uploads
   raw rows, server fills in `exec_summary` + per-row `ai_notes` in the
   background
