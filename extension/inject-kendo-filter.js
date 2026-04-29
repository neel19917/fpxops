// Runs in the page's main world (loaded via <script src=...> by content.js).
// Drives the FreightPOP Kendo grid's dataSource directly — far more
// reliable than puppeting the column-filter popup, and works even when
// the column isn't currently visible in the user's column selection.
//
// Multi-strategy. Reports back via window.postMessage with rich detail
// so the bridge can tell the user exactly why a filter didn't apply.
//
// Parameters come in via the script tag's data-* attributes; the result
// is posted back with the supplied request id so multiple in-flight
// calls don't cross-talk.
(function () {
  var script = document.currentScript;
  var requestId = script && script.getAttribute("data-fpx-request-id");
  var value = script && script.getAttribute("data-fpx-value");
  var fieldsRaw = script && script.getAttribute("data-fpx-fields");
  var fields;
  try { fields = JSON.parse(fieldsRaw || "null") || []; }
  catch (_e) { fields = []; }
  var defaultFields = ["TrackingNumber", "trackingNumber", "Tracking_Number", "tracking_number", "trackingnumber"];
  if (!fields.length) fields = defaultFields;

  var log = [];
  function note(msg) { log.push(msg); console.log("[FPX-Inject]", msg); }

  function reply(ok, strategy, fieldUsed) {
    window.postMessage({
      source: "fpx-inject-kendo-filter",
      type: "fpx-kendo-filter-result",
      requestId: requestId,
      ok: ok,
      strategy: strategy || null,
      fieldUsed: fieldUsed || null,
      detail: log.join(" | "),
    }, "*");
  }

  var $ = window.jQuery || window.$;
  if (!$ || !$.fn || typeof $.fn.data !== "function") {
    note("jQuery not found on page — cannot use Kendo API");
    reply(false);
    return;
  }
  note("jQuery " + ($.fn.jquery || "(unknown version)") + " present");

  var grids = $(".k-grid").toArray();
  note("found " + grids.length + " .k-grid element(s)");
  if (!grids.length) { reply(false); return; }

  // Strategy A: dataSource.filter() with a known field name. Try our
  // candidate list AND every column the grid declares — if FreightPOP
  // ever renames the field, this still finds it.
  for (var i = 0; i < grids.length; i++) {
    var grid;
    try { grid = $(grids[i]).data("kendoGrid"); }
    catch (_e) { grid = null; }
    if (!grid || !grid.dataSource) {
      note("grid " + i + ": no kendoGrid widget attached — skipping");
      continue;
    }
    var cols = (grid.columns || []).map(function (c) { return c.field; }).filter(Boolean);
    note("grid " + i + " columns: " + (cols.join(", ") || "(none)"));

    // Build a deduped try-list: candidates that exist in this grid
    // first (best chance of being right), then everything else.
    var existing = fields.filter(function (f) {
      return cols.some(function (c) { return (c || "").toLowerCase() === f.toLowerCase(); });
    });
    // Heuristic: any column whose name has "track" in it is worth trying too.
    var hinted = cols.filter(function (c) { return /track/i.test(c); });
    var seen = {};
    var tries = existing.concat(hinted).concat(fields).concat(cols).filter(function (f) {
      var k = (f || "").toLowerCase();
      if (!k || seen[k]) return false;
      seen[k] = true;
      return true;
    });
    note("grid " + i + " try order: " + tries.join(", "));

    for (var j = 0; j < tries.length; j++) {
      var field = tries[j];
      try {
        grid.dataSource.filter({ field: field, operator: "eq", value: value });
        // Success path: verify the filter actually took by reading back
        // the current filter spec. Some grids accept .filter() but
        // silently no-op when the field isn't real.
        var current = grid.dataSource.filter();
        var applied = false;
        if (current && current.filters) {
          applied = current.filters.some(function (f) {
            return f.field === field && String(f.value) === String(value);
          });
        }
        if (applied) {
          note("dataSource.filter applied via field '" + field + "' on grid " + i);
          reply(true, "kendo-api-datasource", field);
          return;
        } else {
          note("dataSource.filter accepted field '" + field + "' but read-back didn't match — trying next");
        }
      } catch (e) {
        note("dataSource.filter threw for '" + field + "': " + (e && e.message ? e.message : String(e)));
      }
    }
  }

  // Strategy B: scan every grid's column model for a "tracking number"
  // shaped field by title (display text) and call filter() with its
  // declared `field`. Catches grids where field is "TrkNum" or similar
  // and doesn't match any of our string candidates.
  for (var k = 0; k < grids.length; k++) {
    var g2;
    try { g2 = $(grids[k]).data("kendoGrid"); } catch (_e) { g2 = null; }
    if (!g2 || !g2.columns) continue;
    for (var c = 0; c < g2.columns.length; c++) {
      var col = g2.columns[c];
      var title = (col.title || "").toString().toLowerCase();
      var field2 = col.field || "";
      if (!field2) continue;
      // "Tracking Number" / "Tracking #" / "Tracking No" — anything with
      // "tracking" but not "comment".
      if (/track/.test(title) && !/comment/.test(title)) {
        try {
          g2.dataSource.filter({ field: field2, operator: "eq", value: value });
          var verify = g2.dataSource.filter();
          var ok2 = verify && verify.filters && verify.filters.some(function (f) {
            return f.field === field2 && String(f.value) === String(value);
          });
          if (ok2) {
            note("matched by title '" + col.title + "' → field '" + field2 + "' on grid " + k);
            reply(true, "kendo-api-by-title", field2);
            return;
          }
        } catch (e2) {
          note("title-match try failed for '" + field2 + "': " + (e2 && e2.message));
        }
      }
    }
  }

  note("all dataSource.filter attempts exhausted; bridge will try UI fallback");
  reply(false);
})();
