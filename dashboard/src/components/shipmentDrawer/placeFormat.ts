// Pure helpers that turn the scraped ship_from / ship_to strings into
// something readable. No React, no imports — easy to exercise in isolation.
//
// Shapes seen in production:
//   1. "Name: THG CONTRACTORSAddress: 14105 WM DAVIS PKWY UNIT 604 JACKSONVILLE FL 32224TEL:"
//      (scraped labels run together, no separators, all caps)
//   2. "MATHD Rome, 113 Hemlock Street SW, Rome, GA, 30161, US"
//   3. "Ship To:" / "Number of Pieces:" (a label with no value — junk)

export type Place = {
  /** "City, ST" when we can find it, else a cleaned + truncated string. */
  short: string;
  /** Cleaned full address for tooltips: "Name, Street, City ST ZIP". */
  full: string;
};

const SHORT_MAX = 28;

const STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY " +
    // Canadian provinces — same "City, XX POSTAL" layout.
    "AB BC MB NB NL NS NT NU ON PE QC SK YT"
  ).split(" "),
);

// Words that end the street part of an address.
const STREET_SUFFIXES = new Set(
  (
    "ST STREET AVE AV AVENUE RD ROAD BLVD BOULEVARD PKWY PKY PARKWAY DR DRIVE HWY HIGHWAY LN LANE WAY CT COURT " +
    "PL PLACE CIR CIRCLE TRL TRAIL TER TERRACE LOOP PIKE TPKE TURNPIKE PLZ PLAZA SQ EXPY EXPRESSWAY FWY FREEWAY RTE ROUTE ROW ALY"
  ).split(" "),
);

// Unit designators: the token after them belongs to the street too ("STE A").
const UNIT_WORDS = new Set("UNIT STE SUITE APT BLDG BUILDING RM ROOM DOCK DEPT LOT #".split(" "));

const DIRECTIONALS = new Set("N S E W NE NW SE SW".split(" "));

// "ST" followed by one of these is "Saint …", not the end of a street.
const SAINT_NAMES = new Set(
  "LOUIS PAUL PETERSBURG PETERS CHARLES GEORGE CLOUD AUGUSTINE JOSEPH ALBANS CLAIR ROSE HELENA MARYS JOHNS JOHN CROIX MICHAEL".split(" "),
);

// Used only when an address has no commas AND no recognisable street end.
const CITY_LEAD_WORDS = new Set(
  (
    "NEW SAN SANTA LOS LAS EL LA FORT FT SAINT ST PORT MOUNT MT NORTH SOUTH EAST WEST LAKE GRAND DES PALM CAPE " +
    "BATON CORPUS SALT LITTLE CEDAR OKLAHOMA KANSAS JERSEY"
  ).split(" "),
);
const CITY_TAIL_WORDS = new Set(
  "CITY BEACH SPRINGS HEIGHTS PARK FALLS RAPIDS VALLEY HILLS GROVE LAKE ISLAND VILLAGE JUNCTION STATION ROCK".split(" "),
);

const LABEL_RE = /(Name|Address|Telephone|Tel|Phone|Fax|Email|Contact)\s*:/gi;
const LEADING_LABEL_RE = /^(?:ship\s*(?:to|from)|origin|destination|consignee|shipper)\s*:\s*/i;
const COUNTRY_RE = /[\s,]+(?:USA?|U\.S\.(?:A\.?)?|United States(?: of America)?|Canada)\.?$/i;
const TAIL_RE = /^(.*?)([\s,]+|^)([A-Za-z]{2})(?:[\s,]*(\d{5}(?:-\d{4})?|[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d))?$/;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const trimPunct = (s: string) => s.replace(/^[\s,;]+|[\s,;]+$/g, "");
const normToken = (t: string) => (t === "#" ? "#" : t.toUpperCase().replace(/[^A-Z0-9]/g, ""));
const capitalise = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

function truncate(s: string, max = SHORT_MAX): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// "JACKSONVILLE" → "Jacksonville". Mixed-case input is left alone.
function cityCase(s: string): string {
  if (/[a-z]/.test(s)) return s;
  return s.replace(/[A-Z]+/g, capitalise);
}

// Gentler casing for names / streets that arrive in ALL CAPS: title-case
// ordinary words, keep probable initialisms ("THG", "WM", "LLC") as they are.
function softCase(s: string): string {
  if (/[a-z]/.test(s)) return s;
  return s.replace(/[A-Z0-9]+/g, (w) => {
    if (/\d/.test(w)) return /^\d+(ST|ND|RD|TH)$/.test(w) ? w.toLowerCase() : w;
    if (w.length === 1) return w;
    if (STREET_SUFFIXES.has(w) || UNIT_WORDS.has(w)) return capitalise(w);
    return /[AEIOU]/.test(w) ? capitalise(w) : w;
  });
}

// Split the scraped "Name: …Address: …TEL: …" form. The labels are glued to
// the preceding value ("CONTRACTORSAddress:", "32224TEL:"), so we split on
// the label text itself rather than on word boundaries.
function splitLabels(s: string): { name: string; addr: string } {
  LABEL_RE.lastIndex = 0;
  if (!LABEL_RE.test(s)) return { name: "", addr: s };
  const pieces = s.split(LABEL_RE); // [prefix, label, value, label, value, …]
  const prefix = trimPunct(pieces[0] || "");
  let name = "";
  let addr: string | null = null;
  for (let i = 1; i < pieces.length; i += 2) {
    const label = pieces[i].toLowerCase();
    const value = trimPunct(pieces[i + 1] || "");
    if (label === "name" && !name) name = value;
    else if (label === "address" && addr === null) addr = value;
  }
  if (addr === null) return { name, addr: prefix };
  return { name: name || prefix, addr };
}

// Split "14105 WM DAVIS PKWY UNIT 604 JACKSONVILLE" into street + city when
// there are no commas to go by.
//
// Heuristic: the city is whatever follows the LAST street-ish token — a token
// containing a digit, a street suffix (AVE, ST, PKWY…), or a unit designator
// plus its value (UNIT 604, STE A).
//
// Limitation: without commas a multi-word city can't be told apart from the
// street reliably. Streets with no suffix ("100 BROADWAY NEW YORK") fall back
// to a small list of common city lead/tail words (NEW, SAN, … CITY, BEACH) and
// otherwise take just the last word, so e.g. "… BROADWAY WINSTON SALEM" gives
// "Salem". Conversely a city containing a suffix word ("PARK PLACE …") or a
// business name after the street would be mis-split.
function splitStreetCity(text: string): { street: string; city: string } {
  const tokens = text.split(/\s+/).filter(Boolean);
  const n = tokens.length;
  if (!n) return { street: "", city: "" };
  const norm = tokens.map(normToken);
  let cut = 0; // index of the first city token
  let sure = false; // cut was set by a suffix / unit, not just a house number
  for (let i = 0; i < n; i++) {
    const t = norm[i];
    if (/\d/.test(t)) {
      cut = i + 1;
      sure = false;
    } else if (UNIT_WORDS.has(t) && i + 2 < n && (norm[i + 1].length <= 3 || /\d/.test(norm[i + 1]))) {
      cut = i + 2;
      sure = true;
      i++;
    } else if (STREET_SUFFIXES.has(t) && i > 0 && i < n - 1) {
      if (t === "ST" && SAINT_NAMES.has(norm[i + 1])) continue; // "ST LOUIS"
      cut = i + 1;
      sure = true;
    }
  }
  if (cut >= n) return { street: text, city: "" }; // ends in a number: no city here
  if (!sure) {
    // No street suffix after the last number (or no markers at all), so the
    // remaining words are street name + city with nothing to divide them.
    if (cut === 0 && n <= 3) return { street: "", city: text };
    let k = n - 1;
    if (CITY_TAIL_WORDS.has(norm[k]) && k > cut) k--;
    while (k > cut && n - k < 3 && CITY_LEAD_WORDS.has(norm[k - 1])) k--;
    return { street: tokens.slice(0, k).join(" "), city: tokens.slice(k).join(" ") };
  }
  // "… ST NW ATLANTA": a directional right after the street belongs to it.
  while (cut < n - 1 && DIRECTIONALS.has(norm[cut])) cut++;
  return { street: tokens.slice(0, cut).join(" "), city: tokens.slice(cut).join(" ") };
}

/**
 * Parse a scraped address. Returns null when there is nothing usable (empty,
 * or a bare label like "Ship To:").
 */
export function parsePlace(raw: string | null | undefined): Place | null {
  let s = squash(String(raw ?? ""));
  if (!s) return null;
  s = s.replace(LEADING_LABEL_RE, "");

  const labelled = splitLabels(s);
  let name = labelled.name;
  let addr = trimPunct(labelled.addr);

  // A leftover "Something:" with no value is a scraped label, not a place.
  if (/^[^:,\d]{1,40}:$/.test(addr)) addr = "";
  if (/^[^:,\d]{1,40}:$/.test(name)) name = "";
  if (!addr && !name) return null;

  const fallback = (): Place => {
    const full = [softCase(name), softCase(addr)].filter(Boolean).join(", ");
    return { short: truncate(full), full };
  };
  if (!addr) return fallback();

  const body = trimPunct(addr.replace(COUNTRY_RE, ""));
  const m = body.match(TAIL_RE);
  const state = m ? m[3].toUpperCase() : "";
  // A bare two-letter word only counts as a state when something backs it up:
  // a comma before it, a ZIP after it, or it being written in capitals.
  const trusted = !!m && STATES.has(state) && (m[2].includes(",") || !!m[4] || m[3] === state);
  if (!m || !trusted) return fallback();

  const zip = (m[4] || "").toUpperCase();
  const parts = m[1].split(",").map(squash).filter(Boolean);
  const last = parts.pop() || "";
  let city: string;
  let streetParts = parts;
  if (parts.length && !/\d/.test(last)) {
    city = last; // comma-delimited: the segment before the state is the city
  } else {
    const split = splitStreetCity(last);
    city = split.city;
    if (split.street) streetParts = [...parts, split.street];
  }
  // "ACME, 1 Main St, …": a leading segment that isn't a street is the name.
  if (!name && streetParts.length >= 2 && !/^\d/.test(streetParts[0])) {
    name = streetParts[0];
    streetParts = streetParts.slice(1);
  }

  city = cityCase(city);
  const cityLine = [city, state, zip].filter(Boolean).join(" ");
  const full = [softCase(name), ...streetParts.map(softCase), cityLine].filter(Boolean).join(", ");
  return { short: city ? `${city}, ${state}` : state, full };
}

/** First of the candidates that parses to a real place (skips junk labels). */
export function firstPlace(...candidates: Array<string | null | undefined>): Place | null {
  for (const c of candidates) {
    const p = parsePlace(c);
    if (p) return p;
  }
  return null;
}
