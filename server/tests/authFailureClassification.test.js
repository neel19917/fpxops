import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyGetUserError, peekJwtClaims } from "../lib/auth.js";

// These two helpers carry the whole "did we just log someone out for no
// reason?" decision. resolveJwt used to return null for every kind of failure,
// so requireAuth answered 401 "Invalid session" whether the token was expired
// or whether our own connection to Supabase had hiccuped. The browser reacts to
// a 401 by force-refreshing its token, and a refresh nobody needed is what
// races the SDK's own rotation into "Invalid Refresh Token: Already Used".

describe("classifyGetUserError", () => {
  it("treats 401 as the token's fault (client should refresh)", () => {
    assert.equal(classifyGetUserError({ status: 401, message: "invalid JWT" }), "invalid_token");
  });

  it("treats 403 as the token's fault", () => {
    assert.equal(classifyGetUserError({ status: 403, message: "forbidden" }), "invalid_token");
  });

  it("treats a transport failure (no status) as OUR problem, not the token's", () => {
    // fetch rejections surface with status undefined / 0. This is the case that
    // used to masquerade as an expired session.
    assert.equal(classifyGetUserError({ message: "fetch failed" }), "upstream");
    assert.equal(classifyGetUserError({ status: 0, message: "socket hang up" }), "upstream");
    assert.equal(classifyGetUserError({ status: undefined }), "upstream");
  });

  it("treats 5xx from Supabase as OUR problem", () => {
    for (const status of [500, 502, 503, 504]) {
      assert.equal(classifyGetUserError({ status }), "upstream", `status ${status}`);
    }
  });

  it("treats 429 as upstream — a rate limit is not an invalid credential", () => {
    assert.equal(classifyGetUserError({ status: 429 }), "upstream");
  });

  it("never throws on a malformed or absent error object", () => {
    assert.equal(classifyGetUserError(null), "upstream");
    assert.equal(classifyGetUserError(undefined), "upstream");
    assert.equal(classifyGetUserError({}), "upstream");
  });
});

describe("peekJwtClaims", () => {
  function makeJwt(payload) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
  }

  it("extracts sub and exp so a failure log names the token", () => {
    const claims = peekJwtClaims(makeJwt({ sub: "6a3d773b", exp: 1786375175, email: "a@b.com" }));
    assert.equal(claims.sub, "6a3d773b");
    assert.equal(claims.exp, 1786375175);
    assert.equal(claims.email, "a@b.com");
  });

  it("handles base64url payloads needing padding", () => {
    // Payload lengths that aren't a multiple of 4 once base64'd are the common
    // case; a decoder that forgets padding silently returns {} for most tokens.
    for (const sub of ["a", "ab", "abc", "abcd", "abcde"]) {
      assert.equal(peekJwtClaims(makeJwt({ sub })).sub, sub, `sub=${sub}`);
    }
  });

  it("returns {} rather than throwing on garbage — it's only used for logging", () => {
    assert.deepEqual(peekJwtClaims("not-a-jwt"), {});
    assert.deepEqual(peekJwtClaims(""), {});
    assert.deepEqual(peekJwtClaims(null), {});
    assert.deepEqual(peekJwtClaims(undefined), {});
    assert.deepEqual(peekJwtClaims("a.!!!notbase64!!!.c"), {});
  });

  it("does not verify the signature — a forged token still decodes", () => {
    // Explicit: this is a logging aid, never an auth decision. Supabase's
    // getUser() is what actually validates.
    const claims = peekJwtClaims(makeJwt({ sub: "attacker", role: "admin" }));
    assert.equal(claims.sub, "attacker");
  });
});
