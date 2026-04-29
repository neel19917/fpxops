// Runs in the page's main world. Drives the FreightPOP Kendo grid's
// column-filter popup the same way the extension's "Mode → LTL" flow
// does in the side panel — but for a free-text column (Tracking Number).
// The crucial bit is doing this from the main world: that's the only
// place where window.jQuery and the Kendo widget instances are reachable
// (.data('kendoNumericTextBox') / .data('kendoDropDownList') etc.).
//
// Parameters arrive on the script tag as data-* attributes; result is
// posted back via window.postMessage with the supplied request id.
(function () {
  var script = document.currentScript;
  var requestId = script && script.getAttribute("data-fpx-request-id");
  var colName = script && script.getAttribute("data-fpx-column");
  var value = script && script.getAttribute("data-fpx-value");

  var log = [];
  function note(m) { log.push(m); console.log("[FPX-Popup]", m); }
  function reply(ok, fieldUsed) {
    window.postMessage({
      source: "fpx-inject-kendo-popup",
      type: "fpx-kendo-popup-result",
      requestId: requestId,
      ok: ok,
      fieldUsed: fieldUsed || null,
      detail: log.join(" | "),
    }, "*");
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var $ = window.jQuery || window.$;
  if (!$ || !$.fn || typeof $.fn.data !== "function") {
    note("jQuery not on page — cannot drive popup widgets");
    reply(false);
    return;
  }

  // Find the column header. Mirrors the existing applyFilter() but with
  // Kendo widget awareness — the title may live in a column object on the
  // grid widget rather than the visible <th>.
  function findHeader() {
    var want = (colName || "").toLowerCase();
    var fieldGuess = (colName || "").replace(/\s+/g, "").toLowerCase();
    var headers = document.querySelectorAll(".k-grid th");
    // 1. data-field exact
    for (var i = 0; i < headers.length; i++) {
      var f = (headers[i].getAttribute("data-field") || "").toLowerCase();
      if (f && (f === want || f === fieldGuess)) return headers[i];
    }
    // 2. text exact / starts-with / contains-without-comment
    for (var j = 0; j < headers.length; j++) {
      var link = headers[j].querySelector("a.k-link");
      var text = (link ? link.textContent : headers[j].textContent || "").trim().toLowerCase();
      if (text === want) return headers[j];
      if (text.indexOf(want) === 0) return headers[j];
      if (text.indexOf(want) >= 0 && text.indexOf("comment") < 0) return headers[j];
    }
    return null;
  }

  function openFilterPopup(header) {
    var icon = header.querySelector("a.k-grid-filter") ||
               header.querySelector("a.k-grid-filter-menu") ||
               header.querySelector(".k-grid-filter") ||
               header.querySelector("[data-role='columnmenu']");
    if (!icon) { note("filter icon missing on header"); return false; }
    icon.click();
    return true;
  }

  function findOpenPopup() {
    var containers = document.querySelectorAll(".k-animation-container, .k-filter-menu, .k-column-menu");
    for (var i = 0; i < containers.length; i++) {
      var c = containers[i];
      if (c.offsetParent === null && c.style.display === "none") continue;
      var btns = c.querySelectorAll("button");
      for (var j = 0; j < btns.length; j++) {
        if ((btns[j].textContent || "").trim() === "Filter") return c;
      }
    }
    return null;
  }

  function setKendoDropdownTo(dropdownEl, optionText) {
    var $dd = $(dropdownEl);
    var widget = $dd.data("kendoDropDownList") || $dd.data("kendoComboBox");
    if (widget && widget.dataItem) {
      // Find the matching item in the data source.
      var ds = widget.dataSource;
      var data = ds && ds.data ? ds.data() : [];
      for (var i = 0; i < data.length; i++) {
        var t = data[i].text || data[i].Text || data[i];
        if ((t || "").toString().trim() === optionText) {
          if (typeof widget.value === "function") widget.value(data[i].value || t);
          if (widget.trigger) widget.trigger("change");
          return true;
        }
      }
    }
    // Fall back to UI click.
    var wrap = dropdownEl.querySelector(".k-dropdown-wrap, .k-input") || dropdownEl;
    wrap.click();
    return false;
  }

  function setKendoInputValue(input, val) {
    var $i = $(input);
    var widgets = ["kendoNumericTextBox", "kendoMaskedTextBox", "kendoTextBox", "kendoComboBox", "kendoAutoComplete"];
    for (var i = 0; i < widgets.length; i++) {
      var w = $i.data(widgets[i]);
      if (w && typeof w.value === "function") {
        w.value(val);
        if (w.trigger) w.trigger("change");
        note("set value via " + widgets[i]);
        return true;
      }
    }
    // Plain native setter — works for unwrapped <input> too.
    var proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    setter && setter.set && setter.set.call(input, val);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur",  { bubbles: true }));
    note("set value via native setter");
    return true;
  }

  (async function () {
    try {
      var header = findHeader();
      if (!header) {
        var seen = Array.from(document.querySelectorAll(".k-grid th")).map(function (c) {
          var f = c.getAttribute("data-field") || "";
          var t = ((c.querySelector("a.k-link") || {}).textContent || c.textContent || "").trim();
          return f ? t + " (" + f + ")" : t;
        }).filter(Boolean);
        note("column not found. visible headers: " + (seen.join(", ") || "(none)"));
        reply(false);
        return;
      }
      note("matched header: " + ((header.querySelector("a.k-link") || header).textContent || "").trim());

      if (!openFilterPopup(header)) { reply(false); return; }
      // Wait for the popup to actually appear in the DOM. Kendo lazily
      // mounts these so we may need a moment.
      var popup = null;
      for (var t = 0; t < 20; t++) {
        popup = findOpenPopup();
        if (popup) break;
        await sleep(60);
      }
      if (!popup) { note("popup did not appear within ~1.2s"); reply(false); return; }
      note("popup mounted");

      // Operator: prefer the first <select>; otherwise drive the first
      // Kendo dropdown widget. We want "eq" / "Is equal to".
      var selects = popup.querySelectorAll("select");
      if (selects.length >= 1) {
        if (selects[0].value !== "eq") {
          selects[0].value = "eq";
          selects[0].dispatchEvent(new Event("change", { bubbles: true }));
        }
        note("operator set via <select>");
      } else {
        var dd = popup.querySelector("span.k-dropdown, span.k-widget.k-dropdown, [data-role='dropdownlist']");
        if (dd) {
          var setOk = setKendoDropdownTo(dd, "Is equal to");
          note("operator set via Kendo dropdown widget: " + setOk);
          // If we had to click-to-open, pick the item from the popup list.
          if (!setOk) {
            await sleep(250);
            var items = document.querySelectorAll(".k-animation-container .k-list .k-item, .k-popup .k-item");
            for (var k = 0; k < items.length; k++) {
              if ((items[k].textContent || "").trim() === "Is equal to") { items[k].click(); break; }
            }
          }
        }
      }
      await sleep(150);

      // Value: find the first text-like input (skip the dropdown's hidden helpers).
      // Kendo column-filter popups typically have one or two pairs.
      var input = popup.querySelector(
        "input[type='text']:not([aria-hidden='true']), " +
        "input.k-textbox, " +
        "input.k-input:not([aria-hidden='true']), " +
        "input:not([type]):not([aria-hidden='true']), " +
        "input[type='search']"
      );
      if (!input) {
        // Last-ditch: any visible input that isn't a checkbox / hidden.
        var allInputs = popup.querySelectorAll("input");
        for (var m = 0; m < allInputs.length; m++) {
          var inEl = allInputs[m];
          if (inEl.type === "hidden" || inEl.type === "checkbox") continue;
          if (inEl.offsetParent === null) continue;
          input = inEl; break;
        }
      }
      if (!input) { note("no text input found in popup"); reply(false); return; }
      input.focus();
      setKendoInputValue(input, value);
      await sleep(150);

      // Click Filter — the same logic as the side panel's run() flow.
      var filterBtn = null;
      var btns = popup.querySelectorAll("button");
      for (var n = 0; n < btns.length; n++) {
        if ((btns[n].textContent || "").trim() === "Filter") { filterBtn = btns[n]; break; }
      }
      if (filterBtn) {
        filterBtn.click();
        note("Filter button clicked");
      } else {
        note("Filter button not found in popup");
      }
      reply(true);
    } catch (e) {
      note("exception: " + (e && e.message ? e.message : String(e)));
      reply(false);
    }
  })();
})();
