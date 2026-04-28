import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decidePendingApiKey } from "../lib/pendingApiKey.js";

// Boundary tests for the one-shot delivery decision. Belt + suspenders for
// the API-key delivery path — every weird shape the row could be in.

const NOW = Date.parse("2026-04-28T12:00:00Z");

describe("decidePendingApiKey — boundary conditions", () => {
  it("treats malformed expiry strings as expired (defensive parse)", () => {
    const v = decidePendingApiKey({
      pending_api_key: "fpx_live_x",
      pending_api_key_expires_at: "not-a-date",
    }, NOW);
    assert.equal(v.plaintext, null);
    assert.equal(v.shouldClear, true,
      "garbage expiry must still clear so we don't keep a stale stash");
  });

  it("returns shouldClear=true even when nowMs equals the expiry exactly (right-open interval)", () => {
    // exp > nowMs is the live test — equality is treated as expired.
    const exp = NOW;
    const v = decidePendingApiKey({
      pending_api_key: "fpx_live_x",
      pending_api_key_expires_at: new Date(exp).toISOString(),
    }, NOW);
    assert.equal(v.plaintext, null);
    assert.equal(v.shouldClear, true);
  });

  it("delivers when nowMs is one ms before expiry", () => {
    const exp = NOW + 1;
    const v = decidePendingApiKey({
      pending_api_key: "fpx_live_x",
      pending_api_key_expires_at: new Date(exp).toISOString(),
    }, NOW);
    assert.equal(v.plaintext, "fpx_live_x");
    assert.equal(v.shouldClear, true);
  });

  it("uses Date.now() when nowMs is omitted (no surprises in production)", () => {
    const exp = Date.now() + 60_000;
    const v = decidePendingApiKey({
      pending_api_key: "fpx_live_y",
      pending_api_key_expires_at: new Date(exp).toISOString(),
    });
    assert.equal(v.plaintext, "fpx_live_y");
  });

  it("non-string pending_api_key is treated as absent (no stash)", () => {
    // Nullish/empty paths are tested elsewhere — this guards against junk types.
    const v1 = decidePendingApiKey({ pending_api_key: 0 }, NOW);
    assert.equal(v1.shouldClear, false);
    const v2 = decidePendingApiKey({ pending_api_key: "" }, NOW);
    assert.equal(v2.shouldClear, false);
  });

  it("ignores extra unrelated columns on the row (forward compat)", () => {
    const exp = NOW + 60_000;
    const v = decidePendingApiKey({
      pending_api_key: "fpx_live_z",
      pending_api_key_expires_at: new Date(exp).toISOString(),
      role: "admin", email: "x@y.z", future_column: 1,
    }, NOW);
    assert.equal(v.plaintext, "fpx_live_z");
    assert.equal(v.shouldClear, true);
  });

  it("never throws — every argument shape returns a verdict object", () => {
    const cases = [undefined, null, 42, "", "row", [], {}, { pending_api_key: null }];
    for (const c of cases) {
      const v = decidePendingApiKey(c, NOW);
      assert.equal(typeof v, "object");
      assert.ok("plaintext" in v && "shouldClear" in v);
    }
  });

  it("deeply expired stashes (years old) still produce a clear verdict", () => {
    const v = decidePendingApiKey({
      pending_api_key: "fpx_live_old",
      pending_api_key_expires_at: "2020-01-01T00:00:00Z",
    }, NOW);
    assert.equal(v.plaintext, null);
    assert.equal(v.shouldClear, true);
  });
});
