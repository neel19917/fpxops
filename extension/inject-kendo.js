// Runs in the page's main world (injected via <script src>) so it can reach
// the Kendo grid widget that content.js — isolated world — cannot. Reads the
// grid's current dataSource and posts a flat, JSON-safe copy back.
//
// Hardened against bad rows: one malformed item (circular reference, odd
// getter, null entry) is skipped and reported, instead of throwing out of
// the loop and losing the whole grid map for the page.
(function() {
  var result = { rows: null, error: null, skipped: 0 };

  // Coerce an arbitrary Kendo field value to something the content script
  // can merge as a string. Dates become ISO (JSON.stringify used to wrap
  // them in literal quotes, which the server's date parser then rejected).
  function toCell(val) {
    if (val === null || val === undefined || val === '') return null;
    var t = typeof val;
    if (t === 'function' || t === 'symbol') return null;
    if (t === 'string') return val;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(val);
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val.toISOString();
    if (t === 'object') {
      // Kendo ObservableObject / ObservableArray expose toJSON(); prefer it so
      // we don't serialize event handlers or parent back-references.
      try {
        var plain = (typeof val.toJSON === 'function') ? val.toJSON() : val;
        if (plain instanceof Date) return isNaN(plain.getTime()) ? null : plain.toISOString();
        var json = JSON.stringify(plain);
        if (json === undefined || json === '{}' || json === '[]' || json === 'null') return null;
        return json;
      } catch (e) {
        try { return String(val); } catch (e2) { return null; }
      }
    }
    try { return String(val); } catch (e3) { return null; }
  }

  try {
    var $ = window.jQuery || window.$;
    if (!$) throw new Error("jQuery not found on page");

    var gridEl = $(".k-grid").first();
    var kendoGrid = gridEl.data("kendoGrid");
    if (!kendoGrid) throw new Error("kendoGrid widget not found");

    var fieldMap = {};
    var columns = kendoGrid.columns || [];
    for (var c = 0; c < columns.length; c++) {
      var col = columns[c];
      if (col && col.field && col.title) fieldMap[col.field] = col.title;
    }

    var ds = kendoGrid.dataSource;
    var total = 0;
    try { total = ds && typeof ds.total === 'function' ? ds.total() : 0; } catch (eT) { total = 0; }
    var allRows = [];
    var seen = {};
    var skipKeys = { _events:1, uid:1, dirty:1, _handlers:1, __metadata:1, parent:1 };

    var rawData = (ds && typeof ds.data === 'function') ? ds.data() : [];
    var count = rawData && typeof rawData.length === 'number' ? rawData.length : 0;
    for (var i = 0; i < count; i++) {
      var item = rawData[i];
      if (!item || typeof item !== 'object') { result.skipped++; continue; }
      var row = {};
      try {
        for (var key in item) {
          if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
          if (skipKeys[key] || key.charAt(0) === '_') continue;
          var cell;
          try { cell = toCell(item[key]); } catch (eCell) { cell = null; }
          if (cell === null) continue;
          var displayName = fieldMap[key] || key;
          row[displayName] = cell;
        }
      } catch (eRow) {
        result.skipped++;
        continue;
      }
      if (Object.keys(row).length === 0) { result.skipped++; continue; }

      var uid = item.uid || (row['ShipmentID'] || '') + '|' + (row['Customer Id'] || '') + '|' + i;
      if (seen[uid]) continue;
      seen[uid] = true;
      allRows.push(row);
    }

    result.rows = allRows;
    result.total = total;
    result.fieldMap = fieldMap;
  } catch(e) {
    result.error = (e && e.message) ? e.message : String(e);
  }

  try {
    window.postMessage({ type: "_fpxKendoResult", payload: result }, "*");
  } catch (ePost) {
    // A row value that survived toCell but isn't structured-cloneable would
    // land here. Fall back to a rows-less result so the caller moves on
    // instead of hanging on its 3s timeout.
    window.postMessage({ type: "_fpxKendoResult", payload: { rows: null, error: "postMessage failed: " + (ePost && ePost.message) } }, "*");
  }
})();
