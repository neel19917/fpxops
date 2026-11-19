// A small in-process TTL cache for slow, read-only API answers.
//
//   const cache = createMemoCache({ maxEntries: 100 });
//   const { value, status, ageMs } = await cache.get(key, () => load(), { ttlMs, staleMs });
//
// status is "hit" (fresh), "stale" (older than ttlMs but within staleMs more:
// returned at once while one background load refreshes it) or "miss" (nothing
// usable was stored: the caller waited for a load).
// - Single flight: while a key is loading, every other get of it shares that
//   one promise (no second query to the database).
// - A failed load is never stored; a failed background refresh keeps the
//   stale value (and is logged).
// - shouldCache(value) === false: the value is returned but not stored.
// - invalidate(prefix) drops every entry whose key starts with prefix ("" or
//   no prefix: all of them), and a load already running for such a key is
//   not stored when it finishes (it read the data before the change).
// - At most maxEntries are kept; the least recently used goes first.
// Keys are plain strings; cacheKey(route, params) builds one with the params
// sorted, so the same query in another order hits the same entry.
//
// Data is kept per process and is never sent to the browser as cacheable:
// routes still answer Cache-Control: private, no-store.

export function cacheKey(route, params = {}) {
  const parts = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`);
  return parts.length ? `${route}?${parts.join("&")}` : route;
}

export function createMemoCache({ maxEntries = 100, ttlMs = 60_000, staleMs = 0, now = Date.now, onError } = {}) {
  const entries = new Map(); // key → { value, storedAt, ttlMs, staleMs }
  const loading = new Map(); // key → { promise, cancelled }
  const warn = onError || ((key, e) => console.warn(`[FPX] cache refresh of ${key} failed: ${e?.message || e}`));

  function store(key, value, opts) {
    entries.delete(key);
    entries.set(key, { value, storedAt: now(), ttlMs: opts.ttlMs, staleMs: opts.staleMs });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function load(key, loader, opts) {
    const running = loading.get(key);
    if (running) return running.promise;
    const job = { cancelled: false, promise: null };
    job.promise = (async () => {
      try {
        const value = await loader();
        if (!job.cancelled && (!opts.shouldCache || opts.shouldCache(value))) store(key, value, opts);
        return value;
      } finally {
        if (loading.get(key) === job) loading.delete(key);
      }
    })();
    loading.set(key, job);
    return job.promise;
  }

  async function get(key, loader, options = {}) {
    const opts = {
      ttlMs: options.ttlMs ?? ttlMs,
      staleMs: options.staleMs ?? staleMs,
      shouldCache: options.shouldCache,
    };
    const had = entries.get(key);
    if (had) {
      const age = now() - had.storedAt;
      if (age < had.ttlMs) {
        entries.delete(key); // most recently used goes last
        entries.set(key, had);
        return { value: had.value, status: "hit", ageMs: age };
      }
      if (age < had.ttlMs + had.staleMs) {
        load(key, loader, opts).catch((e) => warn(key, e));
        return { value: had.value, status: "stale", ageMs: age };
      }
      entries.delete(key);
    }
    const value = await load(key, loader, opts);
    return { value, status: "miss", ageMs: 0 };
  }

  function invalidate(prefix = "") {
    let dropped = 0;
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) { entries.delete(key); dropped += 1; }
    }
    for (const [key, job] of [...loading]) {
      if (key.startsWith(prefix)) { job.cancelled = true; loading.delete(key); }
    }
    return dropped;
  }

  return {
    get,
    invalidate,
    clear: () => invalidate(""),
    get size() { return entries.size; },
    has: (key) => entries.has(key),
  };
}

// ---------- The Invoices hub (GET /audits/erp/summary, /audits/erp/invoicing) ----------
// Both read fpx_erp_transactions and fpx_audit_approvals (through the view
// fpx_erp_invoicing) with the service-role client, so the answer is the same
// for every signed-in user and one shared cache is safe.
export const ERP_HUB_PREFIX = "erp:";
export const ERP_HUB_TTL = {
  summary: { ttlMs: 60_000, staleMs: 10 * 60_000 },
  counts: { ttlMs: 90_000, staleMs: 10 * 60_000 },
  list: { ttlMs: 90_000, staleMs: 10 * 60_000 },
  search: { ttlMs: 20_000, staleMs: 60_000 },
};
export const erpHubCache = createMemoCache({ maxEntries: 150 });

// Called after anything that writes fpx_erp_transactions, fpx_audit_approvals
// or the ERP rows of an audit, so the next hub read loads afresh.
export function invalidateErpHub() {
  return erpHubCache.invalidate(ERP_HUB_PREFIX);
}

// The response headers of a cached answer: X-FPX-Cache hit | miss | stale,
// and never a browser/proxy cache (same as lib/httpCache.js).
export function setCacheHeaders(res, status, ageMs = 0) {
  res.set("X-FPX-Cache", status);
  res.set("X-FPX-Cache-Age", String(Math.floor(ageMs / 1000)));
  res.set("Cache-Control", "private, no-store");
}
