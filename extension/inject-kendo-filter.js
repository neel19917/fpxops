// Runs in the page's main world (loaded via <script src=...> by content.js).
// Drives the FreightPOP Kendo grid's dataSource directly — far more
// reliable than puppeting the column-filter popup, and works even when
// the column isn't currently visible in the user's column selection.
//
// Parameters come in via the script tag's data-* attributes; the result
// is posted back to the content script via window.postMessage with the
// supplied request id so multiple in-flight calls don't cross-talk.
(function () {
  var script = document.currentScript;
  var requestId = script && script.getAttribute("data-fpx-request-id");
  var value = script && script.getAttribute("data-fpx-value");
  var fieldsRaw = script && script.getAttribute("data-fpx-fields");
  var fields;
  try { fields = JSON.parse(fieldsRaw || "null") || ["TrackingNumber", "trackingNumber", "Tracking_Number", "tracking_number"]; }
  catch (_e) { fields = ["TrackingNumber", "trackingNumber", "Tracking_Number", "tracking_number"]; }

  var ok = false;
  var detail = "";
  try {
    var $ = window.jQuery || window.$;
    if (!$ || !$.fn || typeof $.fn.data !== "function") {
      detail = "jQuery not found on page";
    } else {
      var grids = $(".k-grid").toArray();
      if (!grids.length) {
        detail = "no .k-grid found on page";
      } else {
        for (var i = 0; i < grids.length && !ok; i++) {
          var grid = $(grids[i]).data("kendoGrid");
          if (!grid || !grid.dataSource) continue;
          var cols = (grid.columns || []).map(function (c) { return c.field; }).filter(Boolean);
          // Prefer fields that actually exist in this grid's column model;
          // fall through to the raw candidate list as a last resort.
          var matching = cols.length
            ? fields.filter(function (f) { return cols.some(function (c) { return (c || "").toLowerCase() === f.toLowerCase(); }); })
            : [];
          var tries = matching.concat(fields);
          for (var j = 0; j < tries.length; j++) {
            try {
              grid.dataSource.filter({ field: tries[j], operator: "eq", value: value });
              ok = true;
              detail = "filter applied via field '" + tries[j] + "' (grid " + i + " of " + grids.length + ")";
              console.log("[FPX-Inject]", detail);
              break;
            } catch (e) {
              console.warn("[FPX-Inject] try failed for", tries[j], e);
            }
          }
        }
        if (!ok) detail = "no kendoGrid accepted the filter; fields tried: " + fields.join(", ");
      }
    }
  } catch (e) {
    detail = "exception: " + (e && e.message ? e.message : String(e));
    console.warn("[FPX-Inject] Kendo API filter exception:", e);
  }

  window.postMessage({
    source: "fpx-inject-kendo-filter",
    type: "fpx-kendo-filter-result",
    requestId: requestId,
    ok: ok,
    detail: detail,
  }, "*");
})();
