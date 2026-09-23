import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, resolveWithIndex } from "../lib/people.js";

const idx = buildIndex([
  { email: "victorz@freightpop.com", full_name: "Victor Zarate" },
  { email: "allenj@freightpop.com", full_name: "Allen Joncas" },
  { email: "neelp@freightpop.com", full_name: "Neel Patel" },
  { email: "shaunz@freightpop.com", full_name: "Shaun Zimmerman" },
  { email: "nofull@freightpop.com", full_name: null },
]);

describe("resolveWithIndex", () => {
  it("maps email, full name and unique first name onto the email", () => {
    assert.equal(resolveWithIndex(idx, "victorz@freightpop.com"), "victorz@freightpop.com");
    assert.equal(resolveWithIndex(idx, "VictorZ@FreightPOP.com"), "victorz@freightpop.com");
    assert.equal(resolveWithIndex(idx, "Victor Zarate"), "victorz@freightpop.com");
    assert.equal(resolveWithIndex(idx, "victor zarate "), "victorz@freightpop.com");
    assert.equal(resolveWithIndex(idx, "Allen"), "allenj@freightpop.com");
    assert.equal(resolveWithIndex(idx, "Allen Joncas"), "allenj@freightpop.com");
  });
  it("passes unknown strings through and nulls blanks", () => {
    assert.equal(resolveWithIndex(idx, "Bob from the warehouse"), "Bob from the warehouse");
    assert.equal(resolveWithIndex(idx, ""), null);
    assert.equal(resolveWithIndex(idx, null), null);
    assert.equal(resolveWithIndex(idx, "   "), null);
  });
  it("does not resolve an ambiguous first name", () => {
    const amb = buildIndex([
      { email: "a@x.com", full_name: "Sam One" }, { email: "b@x.com", full_name: "Sam Two" },
    ]);
    assert.equal(resolveWithIndex(amb, "Sam"), "Sam");
    assert.equal(resolveWithIndex(amb, "Sam Two"), "b@x.com");
  });
  it("names map falls back to the email when there is no full name", () => {
    assert.equal(idx.names.get("nofull@freightpop.com"), "nofull@freightpop.com");
    assert.equal(idx.names.get("victorz@freightpop.com"), "Victor Zarate");
  });
});
