import crypto from "node:crypto";

// Send a JSON response with a strong ETag and a private Cache-Control window.
// Honors If-None-Match to short-circuit to 304 (no body) when the client
// already has the same payload — saves bandwidth on tab switches.
//
// `private` is intentional: every authenticated response is user-scoped via
// Bearer JWT or API key, and must NEVER be cached by a shared/edge proxy.
// max-age + stale-while-revalidate let the browser serve instantly on repeat
// navigations within the window while revalidating in the background.
export function sendCachedJson(req, res, body, { maxAge = 15, swr = 60 } = {}) {
  const json = JSON.stringify(body);
  const etag = `W/"${crypto.createHash("sha1").update(json).digest("base64")}"`;
  res.set("ETag", etag);
  res.set("Cache-Control", `private, max-age=${maxAge}, stale-while-revalidate=${swr}`);
  if (req.header("If-None-Match") === etag) {
    return res.status(304).end();
  }
  res.type("application/json").send(json);
}
