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
