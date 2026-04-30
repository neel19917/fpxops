import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sendCachedJson } from "../lib/httpCache.js";

// sendCachedJson sets a Cache-Control header and writes the body via res.json().
// We mock the Express res just enough to capture the calls.
function makeRes() {
  const calls = { setKey: null, setVal: null, jsonBody: null, jsonCount: 0, setCount: 0 };
  return {
    set(key, val) { calls.setCount++; calls.setKey = key; calls.setVal = val; return this; },
    json(body) { calls.jsonCount++; calls.jsonBody = body; return this; },
    _calls: calls,
  };
}

describe("sendCachedJson", () => {
  it("sets Cache-Control to private, no-store so browsers always revalidate", () => {
    // We removed the max-age window in 2026-04 because it caused a
    // 'refresh twice to see my change' bug across admin pages: after a
    // server cache bust, the browser still had cached responses on disk.
    const res = makeRes();
    sendCachedJson({}, res, { ok: true });
    assert.equal(res._calls.setKey, "Cache-Control");
    assert.equal(res._calls.setVal, "private, no-store");
  });

  it("ALWAYS uses `private` — never `public` (would leak across users on shared CDNs)", () => {
    const res = makeRes();
    sendCachedJson({}, res, { ok: true });
    assert.ok(res._calls.setVal.includes("private"));
    assert.ok(!res._calls.setVal.includes("public"));
  });

  it("ALWAYS includes no-store so the browser never serves a stale response", () => {
    const res = makeRes();
    sendCachedJson({}, res, { ok: true });
    assert.ok(res._calls.setVal.includes("no-store"));
  });

  it("ignores any opts argument (kept for backwards compatibility with old call sites)", () => {
    // Old signature accepted { maxAge, swr } — those are now no-ops.
    const res = makeRes();
    sendCachedJson({}, res, { ok: true }, { maxAge: 120, swr: 300 });
    assert.equal(res._calls.setVal, "private, no-store");
  });

  it("forwards the body unchanged to res.json()", () => {
    const res = makeRes();
    const body = { data: [{ id: 1 }, { id: 2 }], meta: { total: 2 } };
    sendCachedJson({}, res, body);
    assert.equal(res._calls.jsonBody, body, "body must be the same reference");
    assert.equal(res._calls.jsonCount, 1);
  });

  it("calls res.set exactly once and res.json exactly once (no accidental double-write)", () => {
    const res = makeRes();
    sendCachedJson({}, res, { ok: true });
    assert.equal(res._calls.setCount, 1);
    assert.equal(res._calls.jsonCount, 1);
  });

  it("handles an empty body (null) without throwing", () => {
    const res = makeRes();
    sendCachedJson({}, res, null);
    assert.equal(res._calls.jsonBody, null);
  });
});
