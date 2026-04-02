(function() {
  var result = { rows: null, error: null };
  try {
    var $ = window.jQuery || window.$;
    if (!$) throw new Error("jQuery not found on page");

    var gridEl = $(".k-grid").first();
    var kendoGrid = gridEl.data("kendoGrid");
    if (!kendoGrid) throw new Error("kendoGrid widget not found");

    var fieldMap = {};
    var columns = kendoGrid.columns || [];
    for (var c = 0; c < columns.length; c++) {
      if (columns[c].field && columns[c].title) {
        fieldMap[columns[c].field] = columns[c].title;
      }
    }

    var ds = kendoGrid.dataSource;
    var total = ds.total();
    var allRows = [];
    var seen = {};
    var skipKeys = { _events:1, uid:1, dirty:1, _handlers:1, __metadata:1 };

    var rawData = ds.data();
    for (var i = 0; i < rawData.length; i++) {
      var item = rawData[i];
      var row = {};
      for (var key in item) {
        if (!item.hasOwnProperty(key)) continue;
        if (skipKeys[key] || key.charAt(0) === '_') continue;
        var val = item[key];
        if (val === null || val === undefined || val === '') continue;
        var displayName = fieldMap[key] || key;
        row[displayName] = (typeof val === 'object') ? JSON.stringify(val) : String(val);
      }
      if (Object.keys(row).length === 0) continue;

      var uid = item.uid || (row['ShipmentID'] || '') + '|' + (row['Customer Id'] || '') + '|' + i;
      if (seen[uid]) continue;
      seen[uid] = true;
      allRows.push(row);
    }

    result.rows = allRows;
    result.total = total;
    result.fieldMap = fieldMap;
  } catch(e) {
    result.error = e.message;
  }

  window.postMessage({ type: "_fpxKendoResult", payload: result }, "*");
})();
