// Runs in the PAGE's main world (injected as a <script> by content.js), where
// window.jQuery and the Kendo widgets live — content scripts can't see them.
//
// Attributes on the injecting <script>:
//   data-fpx-request-id  correlates the postMessage reply
//   data-fpx-mode        "filter" (default) | "clear"
//   data-fpx-value       value to filter on (eq)
//   data-fpx-fields      JSON array of candidate field names, in priority order
//   data-fpx-title-re    optional regex (string) to match column TITLES as a
//                        last resort, e.g. "^tracking( number| #| no)?$"
//   data-fpx-keep-empty  "1": apply the filter on ONE field (the column whose
//                        title matches, else the first known field) and keep
//                        it even with zero rows. Used after a lookup misses,
//                        so the user sees "Shipment Id = X → 0 items" and
//                        knows it isn't on this dashboard.
//
// Rules (learned the hard way):
//   * Only filter on fields the grid actually has — its columns, its data
//     model, or keys of a loaded row. Filtering an unknown field makes
//     FreightPOP's server return nothing and leaves the grid empty.
//   * Never match "Tracking Comments"-style columns for a tracking lookup.
//   * After applying a filter, wait for the (server-side) data to load and
//     check the row count. Zero rows → restore the previous filter and try the
//     next candidate, so a miss never leaves the user staring at an empty grid.
(function () {
  var script = document.currentScript;
  var attr = function (n) { return script && script.getAttribute(n); };
  var requestId = attr("data-fpx-request-id");
  var mode = attr("data-fpx-mode") || "filter";
  var value = attr("data-fpx-value");
  // "eq" (default) or "contains". Contains is a fallback for identifiers
  // FreightPOP stores with different formatting (leading zeros, prefixes);
  // with it, a match only counts when it narrows the grid to ONE row.
  var op = attr("data-fpx-op") === "contains" ? "contains" : "eq";
  var keepEmpty = attr("data-fpx-keep-empty") === "1";
  var titleRe = null;
  try { titleRe = attr("data-fpx-title-re") ? new RegExp(attr("data-fpx-title-re"), "i") : null; } catch (_e) { titleRe = null; }
  var fields;
  try { fields = JSON.parse(attr("data-fpx-fields") || "null") || []; } catch (_e) { fields = []; }
  if (!fields.length) fields = ["TrackingNumber", "trackingNumber", "Tracking_Number", "tracking_number"];

  var log = [];
  function note(msg) { log.push(msg); }
  function reply(ok, extra) {
    window.postMessage(Object.assign({
      source: "fpx-inject-kendo-filter",
      type: "fpx-kendo-filter-result",
      requestId: requestId,
      ok: ok,
      detail: log.join(" | "),
    }, extra || {}), "*");
  }

  var $ = window.jQuery || window.$;
  if (!$ || !$.fn || typeof $.fn.data !== "function") { note("jQuery not found"); reply(false); return; }
  var grids = $(".k-grid").toArray()
    .map(function (el) { try { return $(el).data("kendoGrid"); } catch (_e) { return null; } })
    .filter(function (g) { return g && g.dataSource; });
  note(grids.length + " kendo grid(s)");
  if (!grids.length) { reply(false); return; }

  if (mode === "clear") {
    // Wait for each grid to reload so callers start from a clean, unfiltered
    // grid (a stale filtered row once passed for a successful lookup).
    Promise.all(grids.map(function (g) {
      var f = g.dataSource.filter();
      if (!f || !f.filters || !f.filters.length) return Promise.resolve();
      return afterLoad(g.dataSource, function () { g.dataSource.filter({}); }, 8000);
    })).then(function () { note("cleared filters"); reply(true, { strategy: "clear" }); });
    return;
  }

  // Resolve once the dataSource finishes its next load (server paging/filtering
  // is async), or after timeoutMs.
  function afterLoad(ds, apply, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      try { ds.one("change", function () { setTimeout(finish, 50); }); } catch (_e) {}
      setTimeout(finish, timeoutMs);
      try { apply(); } catch (e) { note("filter threw: " + (e && e.message)); finish(); }
    });
  }

  function knownFields(g) {
    var known = {};
    (g.columns || []).forEach(function (c) { if (c.field) known[c.field.toLowerCase()] = c.field; });
    try {
      var mf = g.dataSource.options && g.dataSource.options.schema && g.dataSource.options.schema.model && g.dataSource.options.schema.model.fields;
      if (mf) Object.keys(mf).forEach(function (k) { known[k.toLowerCase()] = k; });
    } catch (_e) {}
    try {
      var first = g.dataSource.data()[0];
      if (first) Object.keys(first.toJSON ? first.toJSON() : first).forEach(function (k) { known[k.toLowerCase()] = k; });
    } catch (_e) {}
    return known;
  }

  // Match the type the grid stores for this field: FreightPOP's server
  // compares Shipment Id as a number, so "15665265" (string) found nothing.
  function typedValue(g, field) {
    try {
      var t = g.dataSource.options && g.dataSource.options.schema && g.dataSource.options.schema.model
        && g.dataSource.options.schema.model.fields && g.dataSource.options.schema.model.fields[field]
        && g.dataSource.options.schema.model.fields[field].type;
      var sample = g.dataSource.data()[0];
      var sv = sample ? sample[field] : undefined;
      if ((t === "number" || typeof sv === "number") && /^-?\d+(\.\d+)?$/.test(String(value))) return Number(value);
    } catch (_e) {}
    return value;
  }

  async function tryField(g, gi, field) {
    var ds = g.dataSource;
    var prev = ds.filter() || {};
    var v = op === "contains" ? String(value) : typedValue(g, field);
    await afterLoad(ds, function () { ds.filter({ field: field, operator: op, value: v }); }, 8000);
    var total = typeof ds.total === "function" ? ds.total() : ds.view().length;
    if (total > 0 && (op === "eq" || total === 1)) {
      note("grid " + gi + ": '" + field + "' " + op + " " + JSON.stringify(v) + " → " + total + " row(s)");
      return total;
    }
    note("grid " + gi + ": '" + field + "' " + op + " " + JSON.stringify(v) + " → " + total + " row(s)" + (total ? " (not unique)" : "") + ", restoring previous filter");
    await afterLoad(ds, function () { ds.filter(prev && prev.filters ? prev : {}); }, 8000);
    return 0;
  }

  (async function run() {
    for (var gi = 0; gi < grids.length; gi++) {
      var g = grids[gi];
      var known = knownFields(g);
      var tries = [];
      fields.forEach(function (f) { var real = known[String(f).toLowerCase()]; if (real && tries.indexOf(real) < 0) tries.push(real); });
      if (titleRe) {
        (g.columns || []).forEach(function (c) {
          var t = String(c.title || "");
          if (c.field && titleRe.test(t) && !/comment/i.test(t) && tries.indexOf(c.field) < 0) tries.push(c.field);
        });
      }
      note("grid " + gi + " candidates: " + (tries.join(", ") || "(none present)"));
      if (keepEmpty && tries.length) {
        // Prefer the column whose title names it ("Shipment Id"), not an
        // internal field that happens to share a name (e.g. "Id").
        var titled = (g.columns || []).filter(function (c) { return c.field && titleRe && titleRe.test(String(c.title || "")); }).map(function (c) { return c.field; });
        var field = titled[0] || tries[0];
        var ds = g.dataSource;
        var v = typedValue(g, field);
        await afterLoad(ds, function () { ds.filter({ field: field, operator: "eq", value: v }); }, 8000);
        var total = typeof ds.total === "function" ? ds.total() : ds.view().length;
        note("grid " + gi + ": showing '" + field + "' eq " + JSON.stringify(v) + " → " + total + " row(s) (kept)");
        reply(true, { strategy: "kendo-api-kept", fieldUsed: field, rows: total });
        return;
      }
      if (!tries.length) note("grid " + gi + " columns: " + (g.columns || []).filter(function (c) { return c.field; }).map(function (c) { return (c.title || "?") + "=" + c.field; }).join(", "));
      for (var j = 0; j < tries.length; j++) {
        var rows = await tryField(g, gi, tries[j]);
        if (rows > 0) { reply(true, { strategy: "kendo-api", fieldUsed: tries[j], rows: rows }); return; }
      }
    }
    note("no matching rows via the Kendo API");
    reply(false);
  })();
})();
