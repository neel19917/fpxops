import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cacheKey, createMemoCache, erpHubCache, invalidateErpHub, setCacheHeaders, ERP_HUB_PREFIX,
} from "../lib/memoCache.js";

// A clock the test moves by hand.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; } };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((r) => setImmediate(r));

describe("cacheKey", () => {
  it("sorts params and drops empty ones", () => {
    assert.equal(cacheKey("r", { b: "2", a: 1, c: "", d: null, e: undefined }), "r?a=1&b=2");
    assert.equal(cacheKey("r", { a: 1, b: "2" }), cacheKey("r", { b: "2", a: 1 }));
    assert.equal(cacheKey("r"), "r");
  });
  it("encodes values so one param cannot pose as two", () => {
    assert.notEqual(cacheKey("r", { q: "x&kind=edi" }), cacheKey("r", { q: "x", kind: "edi" }));
  });
});

describe("createMemoCache TTL", () => {
  it("misses, then hits until the ttl runs out", async () => {
    const c = clock();
    const cache = createMemoCache({ now: c.now, ttlMs: 1000 });
    let loads = 0;
    const loader = async () => ++loads;
    assert.deepEqual(await cache.get("k", loader), { value: 1, status: "miss", ageMs: 0 });
    c.tick(500);
    assert.deepEqual(await cache.get("k", loader), { value: 1, status: "hit", ageMs: 500 });
    c.tick(600);
    const after = await cache.get("k", loader);
    assert.equal(after.status, "miss");
    assert.equal(after.value, 2);
    assert.equal(loads, 2);
  });

  it("takes ttl per call", async () => {
    const c = clock();
    const cache = createMemoCache({ now: c.now, ttlMs: 1000 });
    await cache.get("k", async () => 1, { ttlMs: 10_000 });
    c.tick(5000);
    assert.equal((await cache.get("k", async () => 2)).status, "hit");
  });

  it("never stores a failed load", async () => {
    const cache = createMemoCache();
    await assert.rejects(cache.get("k", async () => { throw new Error("boom"); }), /boom/);
    assert.equal(cache.has("k"), false);
    assert.equal((await cache.get("k", async () => 7)).value, 7);
  });

  it("does not store a value shouldCache refuses", async () => {
    const cache = createMemoCache();
    const r = await cache.get("k", async () => ({ n: null }), { shouldCache: (v) => v.n !== null });
    assert.deepEqual(r.value, { n: null });
    assert.equal(cache.has("k"), false);
  });

  it("keeps at most maxEntries, dropping the least recently used", async () => {
    const cache = createMemoCache({ maxEntries: 2 });
    await cache.get("a", async () => 1);
    await cache.get("b", async () => 2);
    await cache.get("a", async () => 1); // a used again
    await cache.get("c", async () => 3);
    assert.equal(cache.size, 2);
    assert.equal(cache.has("a"), true);
    assert.equal(cache.has("b"), false);
    assert.equal(cache.has("c"), true);
  });
});

describe("createMemoCache single flight", () => {
  it("concurrent misses share one load", async () => {
    const cache = createMemoCache();
    const d = deferred();
    let loads = 0;
    const loader = () => { loads += 1; return d.promise; };
    const all = Promise.all([cache.get("k", loader), cache.get("k", loader), cache.get("k", loader)]);
    d.resolve("v");
    const got = await all;
    assert.equal(loads, 1);
    assert.deepEqual(got.map((g) => g.value), ["v", "v", "v"]);
    assert.deepEqual(got.map((g) => g.status), ["miss", "miss", "miss"]);
  });

  it("a failed shared load rejects every waiter and the next get loads again", async () => {
    const cache = createMemoCache();
    const d = deferred();
    const a = cache.get("k", () => d.promise);
    const b = cache.get("k", () => d.promise);
    d.reject(new Error("down"));
    await assert.rejects(a, /down/);
    await assert.rejects(b, /down/);
    assert.equal((await cache.get("k", async () => "ok")).value, "ok");
  });

  it("different keys load apart", async () => {
    const cache = createMemoCache();
    let loads = 0;
    await Promise.all([cache.get("a", async () => ++loads), cache.get("b", async () => ++loads)]);
    assert.equal(loads, 2);
  });
});

describe("createMemoCache stale-while-revalidate", () => {
  it("serves the stale value at once and refreshes it in the background", async () => {
    const c = clock();
    const cache = createMemoCache({ now: c.now, ttlMs: 1000, staleMs: 5000 });
    await cache.get("k", async () => "old");
    c.tick(2000);
    const d = deferred();
    let loads = 0;
    const loader = () => { loads += 1; return d.promise; };
    const r = await cache.get("k", loader);
    assert.deepEqual(r, { value: "old", status: "stale", ageMs: 2000 });
    // A second stale read while the refresh runs does not start another load.
    assert.equal((await cache.get("k", loader)).status, "stale");
    assert.equal(loads, 1);
    d.resolve("new");
    await flush();
    const after = await cache.get("k", loader);
    assert.deepEqual(after, { value: "new", status: "hit", ageMs: 0 });
  });

  it("keeps the stale value when the refresh fails", async () => {
    const c = clock();
    const errors = [];
    const cache = createMemoCache({ now: c.now, ttlMs: 1000, staleMs: 5000, onError: (k, e) => errors.push([k, e.message]) });
    await cache.get("k", async () => "old");
    c.tick(2000);
    assert.equal((await cache.get("k", async () => { throw new Error("db down"); })).value, "old");
    await flush();
    assert.deepEqual(errors, [["k", "db down"]]);
    assert.equal((await cache.get("k", async () => "new")).status, "stale");
  });

  it("past the stale window a read waits for a fresh load", async () => {
    const c = clock();
    const cache = createMemoCache({ now: c.now, ttlMs: 1000, staleMs: 5000 });
    await cache.get("k", async () => "old");
    c.tick(7000);
    assert.deepEqual(await cache.get("k", async () => "new"), { value: "new", status: "miss", ageMs: 0 });
  });
});

describe("createMemoCache invalidate", () => {
  it("drops the entries under a prefix only", async () => {
    const cache = createMemoCache();
    await cache.get("erp:a", async () => 1);
    await cache.get("erp:b", async () => 2);
    await cache.get("other", async () => 3);
    assert.equal(cache.invalidate("erp:"), 2);
    assert.equal(cache.has("erp:a"), false);
    assert.equal(cache.has("other"), true);
    assert.equal((await cache.get("erp:a", async () => 10)).status, "miss");
  });

  it("with no prefix drops everything", async () => {
    const cache = createMemoCache();
    await cache.get("a", async () => 1);
    await cache.get("b", async () => 2);
    cache.invalidate();
    assert.equal(cache.size, 0);
  });

  it("a load that started before the change is not stored", async () => {
    const cache = createMemoCache();
    const before = deferred();
    const first = cache.get("erp:k", () => before.promise);
    cache.invalidate("erp:");
    // A read after the change does not join the old load.
    let fresh = 0;
    const second = cache.get("erp:k", async () => { fresh += 1; return "after"; });
    before.resolve("before");
    assert.equal((await first).value, "before");
    assert.equal((await second).value, "after");
    assert.equal(fresh, 1);
    assert.equal((await cache.get("erp:k", async () => "x")).value, "after");
  });

  it("a stale refresh running at the change is not stored", async () => {
    const c = clock();
    const cache = createMemoCache({ now: c.now, ttlMs: 1000, staleMs: 5000 });
    await cache.get("erp:k", async () => "old");
    c.tick(2000);
    const d = deferred();
    await cache.get("erp:k", () => d.promise);
    cache.invalidate("erp:");
    d.resolve("read before the change");
    await flush();
    assert.equal(cache.has("erp:k"), false);
  });
});

describe("Invoices hub cache", () => {
  it("invalidateErpHub drops the hub entries", async () => {
    await erpHubCache.get(`${ERP_HUB_PREFIX}summary`, async () => ({ ok: true }));
    assert.equal(erpHubCache.has(`${ERP_HUB_PREFIX}summary`), true);
    invalidateErpHub();
    assert.equal(erpHubCache.has(`${ERP_HUB_PREFIX}summary`), false);
  });

  it("setCacheHeaders says how it was served and keeps private, no-store", () => {
    const set = {};
    setCacheHeaders({ set: (k, v) => { set[k] = v; } }, "stale", 4500);
    assert.deepEqual(set, { "X-FPX-Cache": "stale", "X-FPX-Cache-Age": "4", "Cache-Control": "private, no-store" });
  });
});
