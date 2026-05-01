// Send a JSON response with no browser-side caching. The previous
// implementation set max-age=15 + stale-while-revalidate=60, which was
// causing a "refresh twice to see my change" bug across admin pages:
// after a save, the server's in-process cache was correctly busted, but
// the browser still had up to 75s of cached response on disk. The first
// refresh served stale data; only the second (after browser revalidation)
// showed the change.
//
// Admin list endpoints (settings, users, api-keys, audit-log) are
// low-traffic — the bytes saved by client caching weren't worth the bug.
// Server-side TTL caches and Supabase connection pooling keep server
// load reasonable without browser caching.
//
// `private` is kept as defense-in-depth so any future intermediate proxy
// (CDN, reverse proxy) doesn't accidentally fan-out a user-scoped
// response. `no-store` guarantees the browser never serves a cached
// version, including on Back/Forward navigation.
export function sendCachedJson(_req, res, body, _opts = {}) {
  res.set("Cache-Control", "private, no-store");
  res.json(body);
}
