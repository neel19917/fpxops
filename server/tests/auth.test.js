import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateApiKey, hashApiKey } from "../lib/auth.js";

// Pure-crypto tests. No DB calls — just generation + hashing.

describe("generateApiKey", () => {
  it("returns a string with the fpx_live_ prefix", () => {
    const k = generateApiKey();
    assert.equal(typeof k, "string");
    assert.ok(k.startsWith("fpx_live_"), `expected fpx_live_ prefix, got: ${k}`);
  });

  it("produces high-entropy keys (no two consecutive calls collide in 1000 trials)", () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const k = generateApiKey();
      assert.equal(seen.has(k), false, `collision at iteration ${i}`);
      seen.add(k);
    }
  });

  it("uses base64url alphabet — no `+`, `/`, or `=` padding", () => {
    for (let i = 0; i < 50; i++) {
      const k = generateApiKey();
      const body = k.slice("fpx_live_".length);
      assert.ok(/^[A-Za-z0-9_-]+$/.test(body), `bad alphabet in body: ${body}`);
    }
  });

  it("body decodes to 32 bytes of randomness (256-bit key material)", () => {
    const k = generateApiKey();
    const body = k.slice("fpx_live_".length);
    // base64url → standard base64 + pad for Buffer.from
    const std = body.replace(/-/g, "+").replace(/_/g, "/");
    const padded = std + "=".repeat((4 - std.length % 4) % 4);
    const buf = Buffer.from(padded, "base64");
    assert.equal(buf.length, 32);
  });
});

describe("hashApiKey", () => {
  it("returns a 64-char lowercase hex string (sha256)", () => {
    const h = hashApiKey("fpx_live_anything");
    assert.equal(typeof h, "string");
    assert.equal(h.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(h), `expected hex sha256, got: ${h}`);
  });

  it("is deterministic — same input → same hash", () => {
    const a = hashApiKey("fpx_live_abc");
    const b = hashApiKey("fpx_live_abc");
    assert.equal(a, b);
  });

  it("is sensitive to a single-character change (avalanche)", () => {
    const a = hashApiKey("fpx_live_abc");
    const b = hashApiKey("fpx_live_abd");
    assert.notEqual(a, b);
  });

  it("does not collide between two freshly-generated keys", () => {
    const a = hashApiKey(generateApiKey());
    const b = hashApiKey(generateApiKey());
    assert.notEqual(a, b);
  });

  it("hashes the empty string without throwing", () => {
    const h = hashApiKey("");
    assert.equal(h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "well-known sha256 of empty string");
  });

  it("treats keys with trailing whitespace as different inputs (no implicit trim)", () => {
    // Important: we don't trim — operators must not assume " key " == "key".
    const a = hashApiKey("fpx_live_abc");
    const b = hashApiKey("fpx_live_abc ");
    assert.notEqual(a, b);
  });
});
