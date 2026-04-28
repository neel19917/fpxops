// Send a JSON response with a private Cache-Control window. The browser
// transparently caches within max-age and revalidates in the background
// during the stale-while-revalidate window — no extra wiring on the client.
//
// `private` is intentional: every authenticated response is user-scoped via
// Bearer JWT or API key, and must NEVER be cached by a shared/edge proxy.
//
// We deliberately do NOT short-circuit If-None-Match → 304 here. Express
// already issues weak ETags, and a hand-rolled 304 path tripped the
// dashboard's fetch wrapper (treats 304 as not-ok with an empty body) —
// pages stuck on "Loading…" on repeat visits.
export function sendCachedJson(_req, res, body, { maxAge = 15, swr = 60 } = {}) {
  res.set("Cache-Control", `private, max-age=${maxAge}, stale-while-revalidate=${swr}`);
  res.json(body);
}
