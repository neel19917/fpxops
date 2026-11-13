// Minimal .xlsx reader: first worksheet → array of row objects keyed by the
// header row. Enough for FreightPOP's Transactions export (plain cells, shared
// or inline strings); no styles, formulas or dates-as-serials handling.
// No dependency: a zip is a list of deflated files, and node has zlib.
import zlib from "node:zlib";

// → Map(name → Buffer) for every file in the zip.
export function unzip(buf) {
  // End of central directory: last "PK\x05\x06".
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip (bad central directory entry)");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip (bad local header for ${name})`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, zlib.inflateRawSync(data));
    else throw new Error(`zip entry ${name} uses unsupported compression ${method}`);
  }
  return files;
}

const unesc = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, "&");

const textOf = (xml) => unesc([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// → { headers: string[], rows: object[] } from the first sheet.
export function readXlsx(buf) {
  const files = unzip(buf);
  const sheetName = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]))[0];
  if (!sheetName) throw new Error("the workbook has no worksheet");
  const shared = [];
  const ss = files.get("xl/sharedStrings.xml");
  if (ss) for (const m of ss.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? textOf(m[1]) : "");

  const xml = files.get(sheetName).toString("utf8");
  const grid = [];
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = [];
    let next = 0;
    for (const cm of (rm[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
      const i = ref ? colIndex(ref[1]) : next;
      next = i + 1;
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
      let val = "";
      if (type === "s") val = v !== undefined ? shared[Number(v)] ?? "" : "";
      else if (type === "inlineStr") val = textOf(body);
      else if (type === "b") val = v === "1" ? "true" : "false";
      else if (v !== undefined) val = unesc(v);
      cells[i] = val;
    }
    grid.push(cells);
  }
  // Header = first row with at least 3 filled cells (skips a title line).
  const h = grid.findIndex((r) => r.filter((c) => c !== undefined && String(c).trim() !== "").length >= 3);
  if (h < 0) return { headers: [], rows: [] };
  const headers = Array.from(grid[h], (c) => String(c ?? "").trim());
  const rows = [];
  for (const cells of grid.slice(h + 1)) {
    const row = {};
    let any = false;
    headers.forEach((name, i) => {
      if (!name) return;
      const val = cells[i] ?? "";
      if (String(val).trim() !== "") any = true;
      row[name] = val;
    });
    if (any) rows.push(row);
  }
  return { headers: headers.filter(Boolean), rows };
}
