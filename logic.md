# FPXpress Tracking Refresh — Logic Documentation

## Overview

A Chrome Extension (Manifest V3) that automates bulk shipment tracking refresh on the FreightPOP dashboard (`app.freightpop.com`). It iterates every tracking number in the Kendo UI grid, opens each shipment's detail modal, scrapes the data, optionally sends it to Claude Haiku for AI analysis, and exports everything to a multi-sheet XLSX file.

---

## Architecture

```
popup.html / popup.js       — User interface (filter, start/stop, AI toggle, prompt editor)
background.js               — Service worker (state, Claude API proxy, prompt storage)
content.js                  — Injected page script (DOM automation, scraping, XLSX export)
config.js                   — Hardcoded Anthropic API key (loaded by background.js)
xlsx.full.min.js            — Bundled SheetJS library (injected into page alongside content.js)
```

**Message bus:** All inter-component communication goes through `chrome.runtime.sendMessage`. The popup talks to the background and to content.js (via `chrome.tabs.sendMessage`). Content.js talks back to the popup via the background relay.

---

## Startup Flow

1. User opens the popup → popup.js fires on load:
   - Queries background for current running state (`getState`) and restores UI.
   - Queries background for API key presence (`checkApiKey`) and updates the badge.
   - Loads saved `aiEnabled` preference from `chrome.storage.local`.
   - Loads saved custom prompts from background (`getPrompts`).
   - Populates the filter value dropdown based on the selected filter column.

2. User picks an optional column filter (Mode, Shipment status, Carrier Name, Company Name) and a value, toggles AI on/off, then clicks **Start**.

---

## Start Sequence

```
popup.js: startBtn click
  → chrome.runtime.sendMessage({ type: "setRunning", running: true })   // update background state
  → sendToTab("start", { filterCol, filterVal, aiEnabled })
      → ensureContentScript(tabId)                                       // inject xlsx + content.js if not present
      → chrome.tabs.sendMessage(tabId, { action: "start", ... })
          → content.js: run(filterCol, filterVal, useAi)
```

---

## Main Loop (`run` in content.js)

```
run(filterCol, filterVal, useAi)
  1. Reset stopRequested = false, logRows = []
  2. If filter is set → applyFilter(filterCol, filterVal)
  3. Loop over pages:
       a. processPage()        — process all rows on current page
       b. goToNextPage()       — click Kendo pager "next"; break if disabled/absent
       c. sleep(2000)          — wait for grid reload
  4. After all pages:
       a. If aiEnabled → send summarizeAll to background → get executive summary
       b. downloadXLSX(logRows, summaryText)
       c. Send aiSummary message to popup
       d. sendComplete(final stats)
```

---

## Filter Application (`applyFilter`)

1. Find the matching `<th>` in `.k-grid th` by header text.
2. Click the filter icon (`k-grid-filter`, `k-grid-filter-menu`, `[data-role='columnmenu']`).
3. Wait 800 ms for the filter popup to appear.
4. Find the visible popup that contains a "Filter" button.
5. Set the operator to "Is equal to":
   - Native `<select>`: set `.value = "eq"` and dispatch `change`.
   - Kendo dropdown: click to open, then click the "Is equal to" list item.
6. Set the filter value (three fallback strategies in order):
   - Native `<select>` (second select in popup).
   - Kendo dropdown (second `[data-role='dropdownlist']`).
   - Plain text input (`input[type="text"]`, `input.k-textbox`).
7. Click the "Filter" button to apply.
8. Wait 2 000 ms for the grid to reload.

---

## Per-Page Processing (`processPage`)

### Step 1 — Collect tracking links (`collectTrackingLinks`)

1. Find the `<th data-field="TrackingNumber">` header to get its `data-index`.
2. Count locked (frozen) columns to compute the correct body-table column offset.
3. Iterate `.k-grid-content tbody tr` (falls back to `.k-grid tbody tr`).
4. For each row, pick the correct `<td>` by the computed index.
5. Within that cell, find the clickable element: `<a>`, `[ng-click]`, `[onclick]`, `span[style*='cursor']`, or `span.k-link`.
6. Fallback: any leaf child with numeric text.

### Step 2 — Process each link

For each tracking link on the page:

```
simulateClick(link)           // mousedown + mouseup + click, no scroll
sleep(500)
waitForCloseButton(15000)     // poll every 500 ms for a visible CLOSE button
  if timeout → log error row, continue

sleep(1000)
scrapeModal()                 // extract label/value pairs from the open modal
  → Pattern A: label/strong/b/dt + adjacent sibling or parent container text
  → Pattern B: table th/td pairs

modalData._trackingNumber = trackingNum
modalData._timestamp = ISO timestamp

if aiEnabled:
  sendMessage({ type: "analyzeShipment", data: modalData })
    → background.js: callClaude(systemPrompt, perShipmentPrompt with {{data}} replaced)
    → returns { text } or { error }
  applyAiResponseToRow(modalData, aiResult.text)
  finalizeActionSheetFlag(modalData)
else:
  modalData._needsActionSheet = false

modalData._inputSummary  = buildInputSummary(modalData)
modalData._outputSummary = buildOutputSummary(modalData)
logRows.push(modalData)

simulateClick(closeBtn)
sleep(500), sleep(1000)
```

---

## AI Integration

### Per-shipment analysis (`analyzeShipment` in background.js)

1. Load prompts from `chrome.storage.local` (or defaults).
2. Replace `{{data}}` in `perShipment` prompt with `JSON.stringify(modalData)`.
3. POST to `https://api.anthropic.com/v1/messages` using `claude-haiku-4-5-20251001`, max 1 024 tokens.
4. Return `{ text }` on success or `{ error }` on failure.

### Parsing the AI response (`applyAiResponseToRow`)

The parser is defensive against malformed model output:

1. `extractJsonObject(text)`:
   - Strip markdown code fences.
   - Run `repairModelJson` (fix `"actionRequired": true or false` literals, trailing commas).
   - `JSON.parse` the full text.
   - If that fails, slice from first `{` to last `}` and retry.
   - `findAnalysisObject`: walk the parsed value recursively (up to depth 10) looking for an object whose keys match `actionRequired / issue / recommendation`.

2. If `extractJsonObject` returns null → `scrapeFieldsFromLooseJson` using regex to pull `"issue"`, `"recommendation"`, and boolean `actionRequired` directly from the raw string.

3. `coerceActionRequired`: normalize the raw value to `"YES"` / `"NO"` / `""`.

4. `deriveActionRequired`: if the AI said NO but the `issue` text is not clearly on-track (checked by `isClearlyOnTrackIssue`), escalate to YES.

5. `finalizeActionSheetFlag`: compute `_needsActionSheet` (boolean for the Actions sheet filter) and ensure `_actionRequired` is promoted to YES if the flag is set.

### Executive summary (`summarizeAll` in background.js)

After all pages, content.js sends all `logRows` to background, which replaces `{{allShipments}}` in the summary prompt and calls Claude once more. The result is displayed in the popup AI Summary section and written to the Summary sheet in the XLSX.

---

## XLSX Export (`downloadXLSX`)

Produces a four-sheet workbook via SheetJS:

| Sheet | Contents |
|---|---|
| **Actions** | Rows where `_needsActionSheet === true` |
| **Inputs** | Every row with **dynamic columns** — the union of all scraped modal keys plus `_trackingNumber`, `_timestamp`, and `_error`. AI-derived keys (`_aiRawAnalysis`, `_aiIssue`, `_aiRecommendation`, `_actionRequired`, `_needsActionSheet`, `_inputSummary`, `_outputSummary`) are excluded so the sheet shows raw scraped data only. |
| **All Shipments** | Every scraped row (curated `DISPLAY_COLUMNS` only) |
| **Summary** | Counts (total / action / no-action / errors) + AI executive summary text |

Only columns that have at least one non-empty value across all rows are included. Column widths are auto-fitted (capped at 60 characters). The file is downloaded via a temporary object URL as `fpx-shipment-analysis-<ISO-timestamp>.xlsx`.

---

## Stop Flow

```
popup.js: stopBtn click
  → chrome.runtime.sendMessage({ type: "setRunning", running: false })
  → sendToTab("stop")
      → content.js: stopRequested = true

content.js loop: checks stopRequested before each shipment and after each page
  → if true: downloadXLSX(logRows, "") then sendComplete("Stopped by user...")
```

---

## State Management

| Store | Key | Value |
|---|---|---|
| `background.js` in-memory | `state.running` | boolean |
| `background.js` in-memory | `state.status` | last status string |
| `chrome.storage.local` | `aiEnabled` | boolean |
| `chrome.storage.local` | `smartGateEnabled` | boolean — skip AI for routine shipments |
| `chrome.storage.local` | `prompts` | `{ system, perShipment, summary }` |

The background state allows the popup to restore UI correctly if closed and reopened mid-run.

---

## Customizable Prompts

Three prompts are editable in the "Prompt Settings" collapsible section:

| Prompt | Template variable | Purpose |
|---|---|---|
| System | — | Role/persona for Claude |
| Per-Shipment | `{{data}}` | Analysis prompt sent once per shipment |
| Summary | `{{allShipments}}` | Executive summary prompt sent at the end |

Saved to `chrome.storage.local`. Reset button restores the hardcoded defaults defined in both `popup.js` and `background.js`.

---

## Key Constants & Selectors

| Identifier | Value / Purpose |
|---|---|
| `DISPLAY_COLUMNS` | Ordered list of field keys → human-readable headers for the XLSX |
| `VALUE_OPTIONS` | Static filter values for Mode and Shipment status dropdowns |
| `DEFAULT_PROMPTS` | Default system / per-shipment / summary prompts (duplicated in popup.js and background.js) |
| `.k-grid th` | Kendo grid column headers |
| `.k-grid-content tbody tr` | Kendo grid body rows (scrollable section) |
| `.k-animation-container`, `.k-filter-menu` | Kendo filter popup containers |
| `.k-pager-nav[title="Go to the next page"]` | Kendo pagination next-page button |
| `waitForCloseButton(15000)` | 15 s timeout polling for a visible CLOSE button in the modal |

---

## LTL Redelivery Flagging (server)

Server-side logic (`server/`), added 2026-09-18 at FPX Directory's request: LTL deliveries that must be re-attempted are flagged deterministically, not left to whether the model happens to read it out of the carrier's free-text comment.

### Scope

| Rule | Decision |
|---|---|
| Modes | **LTL only** (`mode` = "LTL", case-insensitive). Parcel is excluded, and parcels never spawn tasks anyway (`ui.tracking.show_parcels`, default off). |
| Refusals | **Not** a redelivery. A refused shipment needs a customer disposition (accept / return / claim), not another attempt. The generic exception rules still catch it. |
| "Attempting to schedule a delivery appointment" | Not a redelivery. |

### Detection (`detectRedelivery` in `server/lib/redelivery.js`)

The signal only exists in free text. There is no status value or date column for it. The detector reads `tracking_comments` + `comments` and checks `delivery_date`:

| Returns | When |
|---|---|
| `true` | LTL, no `delivery_date`, and the comment text matches `REDELIVERY_PATTERN` |
| `false` | LTL with comment text but no match, **or** a `delivery_date` is present |
| `null` | Not LTL, or no comment text at all (could not evaluate) |

`REDELIVERY_PATTERN` matches: *attempted deliver*, *delivery attempt*, *re-attempt*, *redeliver*, *resched*, *tried to deliver*, *unable to deliver*, *could not (be) deliver*, *missed deliver*, *business / consignee / receiver / customer (was / is) closed / unavailable*, *undeliverable*, *no one (was) available / present / home*.

Note: AAA Cooper's event history (`raw_data.Details`) labels a failed attempt "Returned - not delivered". That means back to the terminal, **not** returned to the shipper.

### Where the flag is used

1. **Temporal trigger.** `computeTemporalTriggers` (`routes/analyze.js`) exposes `redelivery_needed` (true / false / null) to the per-shipment prompt.
2. **Prompt rule** (`PER_SHIPMENT_LOGIC` in `prompts.js`). If `redelivery_needed` is true, or the comments describe a failed or rescheduled attempt or a closed consignee with no `delivery_date`, the model must flag it: `issue` starts with "Redelivery needed:", `actionConfidence` ≥ 0.85, and `actionTarget` = carrier (customer if the consignee must schedule). "Out For Delivery" alone does **not** resolve a redelivery; only a `delivery_date`, or a status or comment that explicitly confirms delivery, does.
3. **Auto-tasks** (`autoCreateActionTasks` in `routes/shipments.js`). These run after every scrape upload (`POST /api/shipments`) for every upserted row with `action_required = YES`.

### Task pair

A redelivery gets **two** tasks, where a standard action-required shipment gets one:

| Task | Title |
|---|---|
| Carrier | `Carrier followup: Redelivery — <first sentence of AI recommendation>` |
| Customer | `Customer followup: Redelivery — notify customer of failed delivery attempt` |

The `Redelivery — ` tag (`REDELIVERY_TAG`) is what /tasks search finds. It is also how the task builder recognises existing redelivery tasks: `isRedeliveryTitle` matches the structured tag `^(Carrier|Customer) followup: Redelivery — ` only, never the word anywhere in the title (a legacy free-text title once suppressed a pair). The Carrier/Customer prefix places each task in its Followups panel.

### Dedup and repeat failures

Existing tasks are looked up per shipment with status `open`, `in_progress`, `done` or `cancelled` and `archived_at` null.

| Situation | Result |
|---|---|
| Not a redelivery, shipment already has any task | Skip (one task per shipment, ever) |
| Not a redelivery, no tasks | One standard task |
| Redelivery, no prior redelivery-tagged task | Pair, attempt 1 |
| Redelivery, prior pair exists, `isNewFailureEvent(prev, next)` true | New pair titled `(attempt N)`, N = prior carrier redelivery tasks + 1, with a "failed again" note |
| Redelivery, prior pair exists, no new failure event | Skip |

`isNewFailureEvent(prev, next)` compares the pre-upsert row (`priorByTracking`) with the freshly mapped scrape. It is true when `next` is a redelivery **and** any of these hold:

- `prev` was not in the redelivery state (the shipment re-entered it)
- the comment text changed
- `shipment_status` moved **off** "Out For Delivery" with no delivery date (the out-for-delivery run came back undelivered)
- `updated_eta` changed

**Changed 2026-09-22 (commit `e0992ed`):** a `last_modified_at` tick alone no longer counts. The carrier's "Last Modified Date" is date-only and ticks on any edit to the record. On 373410034 it ticked as the shipment went back **out** for delivery and spawned a bogus "(attempt 2)" pair before anything had failed. `last_modified_at` is also deliberately not in `MATERIAL_FIELDS`, so a stamp tick never triggers a paid re-analysis.

### Known gaps

| Gap | Effect |
|---|---|
| **Hard-deleted tasks respawn.** Dedup only sees tasks that still exist. | Deleting a task on a shipment that is still `action_required = YES` recreates it on the next scrape. To clear one for good, mark it `done` or `cancelled`. (2026-09-22: 45 of 68 tasks deleted in a /tasks clean-up were on still-flagged shipments.) |
| **No ageing.** Detection ignores how old the attempt is. | A 99-day-old "Attempted Delivery" still spawns a pair (the 2026-09-18 backfill included May–July attempts). Shipments that drop off the scraped grid are never re-scraped, never get a `delivery_date`, and their tasks never auto-archive. |
| **Return to shipper is invisible.** | The carrier comment keeps saying "Attempted Delivery…" after the freight is returned, so the shipment still reads as a redelivery. Only an operator note records it (373410034, 2026-09-22). Close the redelivery tasks by hand and track the return separately. |
| **Missed Out For Delivery window.** | If no scrape catches the shipment while it is "Out For Delivery", a second failure in the same city with the same comment is only detected if `updated_eta` moves. |
| **No scrape history.** `fpx_shipment_scrapes` is empty in prod. | Repeat-failure decisions can't be reconstructed after the fact. |

---

## Tasks v2 board (server + dashboard)

Added 2026-09-22 after operators reported "duplicate" and stale tasks on /tasks. Lives at `/tasks/v2` (dashboard `pages/TasksV2.tsx`); the classic page is unchanged and links to it.

### Segmentation (`server/lib/taskSegments.js`)

Every task gets exactly one **segment** from its title and zero or more **health flags** from its shipment row:

| Segment | Rule |
|---|---|
| `redelivery` | `isRedeliveryTitle` (structured `Redelivery — ` tag) |
| `return_claim` | `^(Carrier|Customer) followup: Return/claim — ` |
| `carrier` / `customer` | Carrier/Customer followup prefix (same convention as `/tasks/carrier-followups`) |
| `other` | Anything else |

| Flag | Rule |
|---|---|
| `resolved_upstream` | shipment has `delivery_date`, or `archived_at`, or `action_required` is NO / RESOLVED |
| `stale` | `scraped_at` null or older than `ui.tasks.stale_days` (default 7) |
| `duplicate` | 2+ active tasks on the same shipment |
| `repeat` | title ends in `(attempt N)`, N > 1 |
| `aging` | active and created 5+ days ago |
| `unassigned` / `blocked` | literal |

`buildBoard()` also returns a summary (counts by segment / flag / assignee / carrier / customer, plus `needs_attention` = active redelivery + return/claim + repeat, minus resolved).

### Endpoints (`server/routes/tasks.js`)

| Route | Purpose |
|---|---|
| `GET /api/tasks/v2/board?include_closed=1` | Active tasks (+ done/cancelled from the last 7 days when asked) joined to a slim shipment, classified |
| `POST /api/tasks/v2/triage { ids? \| segment?, notes? }` | Heavy-model pass (setting `prompt.task_triage.model`, default `claude-opus-5`) over the board or a subset, capped at 150 rows. Returns `priority_queue`, `close_candidates`, `batches`, `risks`, `summary`; ids are validated against the input set. Logged to `fpx_ai_analyses` with `metadata.subkind = task_triage` |
| `GET /api/tasks/v2/triage/latest` | Last triage, re-validated against the current active ids so closed tasks drop out |
| `POST /api/tasks/v2/dismiss { ids, disposition?, reason? }` | Cancel-with-reason. Replaces delete on the v2 board: the cancelled row is the dedup tombstone that stops the auto-task builder from respawning the task |

### Models

`model.large` default moved from Sonnet 4.6 to `claude-opus-5`; triage defaults to `claude-opus-5`. Both are admin-editable under Settings → *Tasks v2 — AI triage* / *Models*. Pricing rows for `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1` were added to `MODEL_PRICING`.

---

## Storage-charge risk on delivery holds (server)

Added 2026-09-23 (Allen + Victor): XPO bills storage once freight sits at the destination terminal longer than ~48h waiting for a delivery appointment (arrives Friday, appointment Monday → storage). The agent flags it early so the customer can pull the appointment in or knowingly accept the charge.

### Data

The grid has no arrival-at-destination column (`actual_arrival` is 0% populated), but the extension captures the carrier's event history from the shipment modal in `raw_data.Details` as one flattened string: `<status><status comment><MM/DD/YYYY HH:MM:SS><City><ST>` repeated, newest first. `lib/storageRisk.js#parseCarrierEvents` splits it on the timestamps.

**Extension change (v4.4):** up to v4.3 the extension capped every modal field at 300 chars with a trailing "…", so `Details` kept only the 2–3 newest events and the arrival event was usually cut off before its timestamp. v4.4 gives `Details` its own 8000-char cap (`LONG_VALUE_KEYS` in `extension/content.js`). Until every runner is on v4.4 the server compensates: when the destination phrase sits in the truncated tail, arrival is bounded to the oldest timestamped event (`source: "events_truncated"`, hold hours are a floor). When `Details` is missing entirely (~8% of rows; XPO "History details not found" PROs) it falls back to `tracking_comments` + `last_modified_at` (date-only, so ±1 day).

### Detection (`lib/storageRisk.js#detectStorageRisk`)

| Field (in the prompt's temporal triggers) | Meaning |
|---|---|
| `at_destination_since` | earliest event matching `DESTINATION_PATTERN` (*arrived at destination*, *at destination*, *appointment required at destination*, *held for appointment*, *held on trap trailer*, *closed for delivery*, *available for delivery*, *at delivery terminal*). Deliberately **not** *staged to dock* / *unloaded from trailer* — XPO logs those at origin too. |
| `hold_hours_so_far` | arrival → as_of |
| `hold_hours_at_appointment` | arrival → `appointment_date` (null without an appointment) |
| `storage_carrier_policy` | carrier matches `storage.carriers` (default `XPO`, comma-separated substrings) |
| `storage_hold_limit_hours` | `storage.hold_hours` (default 48) |
| `storage_risk` | LTL + policy carrier + not delivered + (appointment gap > limit, or no appointment and hold ≥ limit/2). `null` = not LTL / not at destination. |

Timestamps are carrier local time read as UTC — the same convention the row's other dates use, so hour math stays consistent.

### What it drives

- **Prompt rule** (`PER_SHIPMENT_LOGIC`): `storage_risk` true → flag, issue starts "Storage risk:", `actionTarget` customer, confidence ≥ 0.85; near-limit exposure is mentioned without flagging.
- **Auto-task**: standard single task tagged `Customer followup: Storage risk — …` (`STORAGE_TAG`), so /tasks search finds it and Tasks v2 puts it in the **Storage risk** segment (counts toward Needs attention).
- **Settings → Storage-charge risk**: `storage.carriers`, `storage.hold_hours`.

Preview on 2026-09-23 (live XPO rows): 200643273 (arrived 9/18, appt 9/22 → 81h) and 200918911 (arrived 9/21, appt 9/24 → 70h) flag; 200919832 (19h) does not.
