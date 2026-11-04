#!/usr/bin/env node
// Packages ../extension into dashboard/public/downloads/ so the dashboard's
// /install page can serve it. Runs before `vite build` (npm "prebuild") and
// `vite` (npm "predev"), so every Netlify deploy ships the extension that
// matches the commit — no hand-built zips to forget to upload.
//
// Writes:
//   public/downloads/FPXpress-extension.zip   — unzips to a single FPXpress/ folder
//   public/downloads/extension.json           — { version, builtAt, bytes, sha256, files }
//
// Zero dependencies: a minimal ZIP writer over node:zlib. Netlify's build
// image has `zip`, but a teammate's Windows box may not.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "..", "extension");
const OUT_DIR = join(here, "..", "public", "downloads");
const ROOT_FOLDER = "FPXpress"; // what the user selects in "Load unpacked"

// Local-only files that must never ship. config.js is gitignored (per-user
// overrides); the example is harmless but noise in a teammate install.
const EXCLUDE = new Set([".DS_Store", "config.js", "config.example.js", "Thumbs.db"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (EXCLUDE.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS timestamp. Fixed to the manifest's mtime-independent build date so the
// archive is stable within a day; exact reproducibility isn't required.
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function buildZip(entries) {
  const now = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);   // local header offset (other fields 0)
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
const files = walk(SRC);
const entries = files.map((full) => ({
  name: `${ROOT_FOLDER}/${relative(SRC, full).split(sep).join("/")}`,
  data: readFileSync(full),
}));

const zip = buildZip(entries);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "FPXpress-extension.zip"), zip);

const meta = {
  version: manifest.version,
  name: manifest.name,
  builtAt: new Date().toISOString(),
  bytes: zip.length,
  sha256: createHash("sha256").update(zip).digest("hex"),
  files: entries.length,
};
writeFileSync(join(OUT_DIR, "extension.json"), JSON.stringify(meta, null, 2) + "\n");

console.log(`✓ Packaged extension v${meta.version} (${entries.length} files, ${(zip.length / 1024).toFixed(0)} KB) → public/downloads/`);
