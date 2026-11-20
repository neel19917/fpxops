// Minimal .xlsx writer, the other half of xlsxRead.js. Two jobs:
//   filterSortXlsx  FreightPOP's own export with some rows dropped and the
//                   rest re-ordered — same sheet, header, columns, cell types
//                   and styles, so it still feeds the user's macros.
//   writeXlsx       a plain workbook from headers + row objects (fallback
//                   when FreightPOP's file was not captured).
// No dependency: a zip is a list of deflated files, and node has zlib.
import zlib from "node:zlib";
import { unzip } from "./xlsxRead.js";

// ── zip ──────────────────────────────────────────────────────────────────────
let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// [{ name, data: Buffer }] → zip file, entries in the order given.
export function zip(entries) {
  const DOS_TIME = 0, DOS_DATE = 0x21; // 1980-01-01: the output depends on the content only
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(String(e.name), "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    if (data.length > 0xfffffffe || comp.length > 0xfffffffe) throw new Error(`zip entry ${e.name} is over 4 GB`);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // names are UTF-8
    local.writeUInt16LE(8, 8);         // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);           // version made by
    cd.writeUInt16LE(20, 6);           // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal attrs, external attrs: 0
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + comp.length;
  }
  if (entries.length > 0xfffe || offset > 0xfffffffe) throw new Error("zip too large (zip64 is not supported)");
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ── xml helpers (same rules as xlsxRead.js) ──────────────────────────────────
const unesc = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, "&");

const textOf = (xml) => unesc([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

// Text → XML text. Characters XML 1.0 does not allow are dropped.
const esc = (s) => String(s)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function colName(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ── reading a sheet, keeping each row's own XML ──────────────────────────────
function firstSheetName(files) {
  return [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]))[0];
}

// → { files, sheetName, xml, dataStart, dataEnd, rows, h, headers }
//   rows: [{ raw, open, num, cells: [{ col, attrs, body, type, val }], vals }]
//   dataStart / dataEnd: where the rows sit in xml (the inside of <sheetData>);
//   h: index of the header row in rows (-1 when there is none).
function parseSheet(buf) {
  const files = unzip(buf);
  const sheetName = firstSheetName(files);
  if (!sheetName) throw new Error("the workbook has no worksheet");
  const shared = [];
  const ss = files.get("xl/sharedStrings.xml");
  if (ss) for (const m of ss.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? textOf(m[1]) : "");

  const xml = files.get(sheetName).toString("utf8");
  const open = /<sheetData\b[^>]*?(\/?)>/.exec(xml);
  if (!open) throw new Error("the worksheet has no <sheetData>");
  let dataStart, dataEnd, selfClosed = false;
  if (open[1]) { selfClosed = true; dataStart = dataEnd = open.index; }
  else {
    dataStart = open.index + open[0].length;
    dataEnd = xml.indexOf("</sheetData>", dataStart);
    if (dataEnd < 0) throw new Error("the worksheet's <sheetData> is not closed");
  }

  const rows = [];
  let prevNum = 0;
  if (!selfClosed) {
    for (const rm of xml.slice(dataStart, dataEnd).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rAttr = /(?:^|\s)r="(\d+)"/.exec(rm[1]);
      const num = rAttr ? Number(rAttr[1]) : prevNum + 1;
      prevNum = num;
      const cells = [];
      const vals = [];
      let next = 0;
      for (const cm of (rm[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1], body = cm[2] || "";
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
        const col = ref ? colIndex(ref[1]) : next;
        next = col + 1;
        const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        let val = "";
        if (type === "s") val = v !== undefined ? shared[Number(v)] ?? "" : "";
        else if (type === "inlineStr") val = textOf(body);
        else if (type === "b") val = v === "1" ? "true" : "false";
        else if (v !== undefined) val = unesc(v);
        vals[col] = val;
        cells.push({ col, attrs, body, type, val });
      }
      rows.push({ raw: rm[0], open: rm[1], num, cells, vals });
    }
  }
  const h = rows.findIndex((r) => r.vals.filter((c) => c !== undefined && String(c).trim() !== "").length >= 3);
  const headers = h < 0 ? [] : Array.from(rows[h].vals, (c) => String(c ?? "").trim());
  return { files, sheetName, xml, dataStart, dataEnd, selfClosed, rows, h, headers };
}

// A data row as readXlsx gives it; null when every cell is blank.
function rowObject(headers, vals) {
  const obj = {};
  let any = false;
  headers.forEach((name, i) => {
    if (!name) return;
    const val = vals[i] ?? "";
    if (String(val).trim() !== "") any = true;
    obj[name] = val;
  });
  return any ? obj : null;
}

// The row's XML with its number changed: <row r> and every cell's r="A5".
// Everything else in it stays byte-for-byte.
function renumber(raw, n) {
  const end = raw.indexOf(">");
  const head = raw.slice(0, end + 1).replace(/(\sr=")\d+(")/, `$1${n}$2`);
  const rest = raw.slice(end + 1).replace(/<c\b[^>]*>/g, (tag) => tag.replace(/(\sr="[A-Z]+)\d+(")/, `$1${n}$2`));
  return head + rest;
}

// A row from another workbook, rebuilt for the base one: cells moved to the
// base's column with the same title, shared strings written inline (their
// index means nothing here), styles kept only when both style sheets match.
function foreignRow(row, colMap, keepStyle, rowAttrs, n) {
  const out = [];
  for (const c of row.cells) {
    const to = colMap.get(c.col);
    if (to === undefined) continue;
    const style = keepStyle ? (/\bs="(\d+)"/.exec(c.attrs) || [])[1] : undefined;
    let xml = `<c r="${colName(to)}${n}"` + (style !== undefined ? ` s="${style}"` : "");
    if (c.type === "s" || c.type === "inlineStr") {
      xml += c.val === "" ? "/>" : ` t="inlineStr"><is><t xml:space="preserve">${esc(c.val)}</t></is></c>`;
    } else {
      xml += (c.type ? ` t="${c.type}"` : "") + (c.body ? `>${c.body}</c>` : "/>");
    }
    out.push({ to, xml });
  }
  out.sort((a, b) => a.to - b.to);
  return `<row r="${n}"${rowAttrs}>${out.map((c) => c.xml).join("")}</row>`;
}

// FreightPOP's export `buf` → the same workbook with only the rows `keep`
// accepts, ordered by `compare`. keep / compare get row objects exactly as
// readXlsx returns them. Only the first worksheet's <sheetData>, <dimension>
// and <autoFilter> change; every other part is copied as it is.
//   more: further exports with the same header titles (the other tab of the
//         report); their data rows join before keep / compare.
export function filterSortXlsx(buf, { keep, compare, more = [] } = {}) {
  const base = parseSheet(buf);
  if (base.h < 0) throw new Error("the Excel file has no header row");
  const headerRow = base.rows[base.h];

  // Every data row: { obj, write(n) → row XML numbered n }.
  const pool = [];
  for (const r of base.rows.slice(base.h + 1)) {
    const obj = rowObject(base.headers, r.vals);
    if (obj) pool.push({ obj, write: (n) => renumber(r.raw, n) });
  }

  // Rows from the other workbooks take the attributes of a base data row
  // (height etc.), minus its number and a row-level style.
  const sample = base.rows[base.h + 1];
  const rowAttrs = sample ? sample.open.replace(/\s(?:r|s|customFormat)="[^"]*"/g, "").replace(/\s+$/, "") : "";
  const baseStyles = base.files.get("xl/styles.xml");
  more.forEach((mbuf, mi) => {
    const m = parseSheet(mbuf);
    if (m.h < 0) throw new Error(`Excel file ${mi + 2} has no header row`);
    // Its column → the base column with the same title (the nth "X" to the nth "X").
    const byTitle = new Map();
    base.headers.forEach((name, i) => { if (name) byTitle.set(name, [...(byTitle.get(name) || []), i]); });
    const colMap = new Map();
    const seen = new Map();
    const missing = [];
    m.headers.forEach((name, i) => {
      if (!name) return;
      const k = seen.get(name) || 0;
      seen.set(name, k + 1);
      const to = (byTitle.get(name) || [])[k];
      if (to === undefined) missing.push(name); else colMap.set(i, to);
    });
    if (!colMap.size) throw new Error(`Excel file ${mi + 2} shares no column title with the first one`);
    if (missing.length) throw new Error(`Excel file ${mi + 2} has column(s) the first one does not: ${missing.slice(0, 8).join(", ")}`);
    const mStyles = m.files.get("xl/styles.xml");
    const keepStyle = !!(baseStyles && mStyles && baseStyles.equals(mStyles));
    for (const r of m.rows.slice(m.h + 1)) {
      const obj = rowObject(m.headers, r.vals);
      if (obj) pool.push({ obj, write: (n) => foreignRow(r, colMap, keepStyle, rowAttrs, n) });
    }
  });

  let kept = keep ? pool.filter((p) => keep(p.obj)) : pool;
  if (compare) kept = kept.map((p, i) => ({ p, i })).sort((a, b) => compare(a.p.obj, b.p.obj) || a.i - b.i).map((x) => x.p);

  // Rows up to the header stay as they are; data rows follow it one by one.
  let n = headerRow.num;
  const sheetData = base.rows.slice(0, base.h + 1).map((r) => r.raw).join("") + kept.map((p) => p.write(++n)).join("");
  const lastRow = n;

  // A range that reached into the data rows now ends on the last row. One
  // that only names the header (Kendo writes <dimension ref="A1"/> and
  // <autoFilter ref="A1:BG1"/>) is still right and is left alone.
  const fixRef = (tag) => tag.replace(/(\sref="[A-Z]+\d+:[A-Z]+)(\d+)(")/, (all, a, end, z) => (Number(end) > headerRow.num ? `${a}${lastRow}${z}` : all));
  const before = base.xml.slice(0, base.dataStart).replace(/<dimension\b[^>]*>/, fixRef);
  const after = base.xml.slice(base.dataEnd).replace(/<autoFilter\b[^>]*>/, fixRef);
  const xml = before + sheetData + after;

  return zip([...base.files].map(([name, data]) => ({ name, data: name === base.sheetName ? Buffer.from(xml, "utf8") : data })));
}

// headers + row objects → a plain workbook, one sheet "Sheet1". Finite JS
// numbers become numeric cells, null / undefined no cell, the rest text.
export function writeXlsx(headers, rows) {
  const heads = (headers || []).map((h) => String(h));
  const cell = (v, c, r) => {
    if (v === null || v === undefined) return "";
    const ref = `${colName(c)}${r}`;
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    const text = typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : String(v);
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
  };
  const lines = [`<row r="1">${heads.map((h, c) => cell(h, c, 1)).join("")}</row>`];
  (rows || []).forEach((row, i) => {
    lines.push(`<row r="${i + 2}">${heads.map((h, c) => cell(row?.[h], c, i + 2)).join("")}</row>`);
  });
  const dim = heads.length ? `A1:${colName(heads.length - 1)}${lines.length}` : "A1";
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const PKG = "http://schemas.openxmlformats.org/package/2006";
  const parts = [
    ["[Content_Types].xml", `${X}<Types xmlns="${PKG}/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>"],
    ["_rels/.rels", `${X}<Relationships xmlns="${PKG}/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${X}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${X}<Relationships xmlns="${PKG}/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `${X}<styleSheet xmlns="${MAIN}">` +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>"],
    ["xl/worksheets/sheet1.xml", `${X}<worksheet xmlns="${MAIN}"><dimension ref="${dim}"/><sheetData>${lines.join("")}</sheetData></worksheet>`],
  ];
  return zip(parts.map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })));
}
