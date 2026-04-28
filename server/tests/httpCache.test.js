import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sendCachedJson } from "../lib/httpCache.js";

// sendCachedJson sets a `private` Cache-Control header and writes the body
// via res.json(). We mock the Express res just enough to capture the calls.
function makeRes() {
  const calls = { setKey: null, setVal: null, jsonBody: null, jsonCount: 0, setCount: 0 };
  return {
    set(key, val) { calls.setCount++; calls.setKey = key; calls.setVal = val; return this; },
    json(body) { calls.jsonCount++; calls.jsonBody = body; return this; },
    _calls: calls,
  };
}

describe("sendCachedJson", () => {
  it("sets a Cache-Control header with default 15s max-age + 60s SWR", () => {
    const res = makeRes();
    sendCachedJson({}, res, { ok: true });
    assert.equal(res._calls.setKey, "Cache-Control");
    assert.equal(res._calls.setVal, "private, max-age=15, stale-while-revalidate=60");
  });

  it("ALWAYS uses `private` — never `public` (would leak across users on shared CDNs)", () => {
    const res = makeRes();
    sendCachedJson({}, res, { ok: true });
    assert.ok(res._calls.setVal.includes("private"));
    assert.ok(!res._calls.setVal.includes("public"));
  });

  it("respects a custom maxAge", () => {
    const res = makeRes();
    sendCachedJson({}, res, { ok: true }, { maxAge: 120 });
    assert.equal(res._calls.setVal, "private, max-age=120, stale-while-revalidate=60");
  });

  it("respects a custom swr", () => {
    const res = makeRes();
    sendCachedJson({}, res, { ok: true }, { swr: 300 });
    assert.equal(res._calls.setVal, "private, max-age=15, stale-while-revalidate=300");
  });

  it("respects both maxAge and swr together", () => {
    const res = makeRes();
    sendCachedJson({}, res, { ok: true }, { maxAge: 30, swr: 90 });
    assert.equal(res._calls.setVal, "private, max-age=30, stale-while-revalidate=90");
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
