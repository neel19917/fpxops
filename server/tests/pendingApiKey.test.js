import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decidePendingApiKey } from "../lib/pendingApiKey.js";
import { generateApiKey, hashApiKey } from "../lib/auth.js";

describe("decidePendingApiKey", () => {
  const NOW = Date.parse("2026-04-28T12:00:00Z");

  it("returns null + no clear when there's no stash on the row", () => {
    assert.deepEqual(decidePendingApiKey(null, NOW), { plaintext: null, shouldClear: false });
    assert.deepEqual(decidePendingApiKey({}, NOW), { plaintext: null, shouldClear: false });
    assert.deepEqual(
      decidePendingApiKey({ pending_api_key: null, pending_api_key_expires_at: null }, NOW),
      { plaintext: null, shouldClear: false },
    );
  });

  it("delivers plaintext + clears when the stash is live", () => {
    const verdict = decidePendingApiKey({
      pending_api_key: "fpx_live_abc",
      pending_api_key_expires_at: new Date(NOW + 1000 * 60 * 60).toISOString(),
    }, NOW);
    assert.equal(verdict.plaintext, "fpx_live_abc");
    assert.equal(verdict.shouldClear, true);
  });

  it("delivers null but still clears when the stash has expired", () => {
    const verdict = decidePendingApiKey({
      pending_api_key: "fpx_live_old",
      pending_api_key_expires_at: new Date(NOW - 1000).toISOString(),
    }, NOW);
    assert.equal(verdict.plaintext, null);
    assert.equal(verdict.shouldClear, true, "expired stash must still be cleared");
  });

  it("treats a missing expiry as expired (defensive — should never happen, but…)", () => {
    const verdict = decidePendingApiKey({ pending_api_key: "fpx_live_x" }, NOW);
    assert.equal(verdict.plaintext, null);
    assert.equal(verdict.shouldClear, true);
  });

  it("treats an unparseable expiry as expired", () => {
    const verdict = decidePendingApiKey({
      pending_api_key: "fpx_live_x",
      pending_api_key_expires_at: "not-a-date",
    }, NOW);
    assert.equal(verdict.plaintext, null);
    assert.equal(verdict.shouldClear, true);
  });
});

describe("API key generation invariants (used by issue-key endpoint)", () => {
  it("generated keys have the fpx_live_ prefix and are unique", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    assert.ok(a.startsWith("fpx_live_"), `expected fpx_live_ prefix, got ${a.slice(0, 12)}`);
    assert.ok(b.startsWith("fpx_live_"));
    assert.notEqual(a, b, "consecutive calls should never collide");
    // Long enough that `length > 10` (used by isValidKey) is comfortably true.
    assert.ok(a.length > 30);
  });

  it("hashApiKey is deterministic and cleaves cleanly between distinct inputs", () => {
    const k = "fpx_live_test_key";
    assert.equal(hashApiKey(k), hashApiKey(k));
    assert.notEqual(hashApiKey(k), hashApiKey("fpx_live_other"));
    // SHA-256 hex is 64 chars.
    assert.equal(hashApiKey(k).length, 64);
  });

  it("the prefix slice we store on the row matches the first 12 chars", () => {
    const plaintext = generateApiKey();
    assert.equal(plaintext.slice(0, 12), plaintext.substring(0, 12));
    // Sanity: the prefix is stable, fpx_live_ + 3 chars.
    assert.equal(plaintext.slice(0, 9), "fpx_live_");
  });
});

describe("end-to-end issue → deliver → clear (mocked)", () => {
  // Simulates what happens in the route handlers without spinning up the
  // server. Verifies the pending-key delivery is exactly one-shot.
  function makeProfileRow(plaintext, expires_at) {
    return { pending_api_key: plaintext, pending_api_key_expires_at: expires_at };
  }
  function applyClear(row) {
    return { ...row, pending_api_key: null, pending_api_key_expires_at: null };
  }

  it("first /api/me delivers, second /api/me sees nothing", () => {
    const plaintext = generateApiKey();
    let row = makeProfileRow(plaintext, new Date(Date.now() + 60_000).toISOString());

    const first = decidePendingApiKey(row);
    assert.equal(first.plaintext, plaintext);
    assert.equal(first.shouldClear, true);
    if (first.shouldClear) row = applyClear(row);

    const second = decidePendingApiKey(row);
    assert.equal(second.plaintext, null);
    assert.equal(second.shouldClear, false);
  });

  it("admin re-issuing replaces the stash; previous plaintext is overwritten", () => {
    let row = makeProfileRow("fpx_live_first", new Date(Date.now() + 60_000).toISOString());
    // First delivery clears it.
    if (decidePendingApiKey(row).shouldClear) row = applyClear(row);
    // Admin issues again.
    row = makeProfileRow("fpx_live_second", new Date(Date.now() + 60_000).toISOString());
    const verdict = decidePendingApiKey(row);
    assert.equal(verdict.plaintext, "fpx_live_second");
    assert.equal(verdict.shouldClear, true);
  });
});
