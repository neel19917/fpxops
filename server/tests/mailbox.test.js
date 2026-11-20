import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret } from "../lib/mailbox/crypto.js";
import {
  _deps, _clearTokenCache, buildGraphUrl, mergePrefer, parseRetryAfter, graphFetch, publicConnection, explainGraphError,
} from "../lib/mailbox/graph.js";
import {
  detectDirection, mapGraphMessage, splitDeltaItems, pageDelta, startUrlFor, initialDeltaPath, MESSAGE_SELECT, bodyToHtml,
} from "../lib/mailbox/sync.js";

const MB = "freightsupport@freightpop.com";

describe("crypto", () => {
  const saved = { k: process.env.MAILBOX_SECRET_KEY, s: process.env.SUPABASE_SERVICE_ROLE_KEY };
  afterEach(() => {
    if (saved.k === undefined) delete process.env.MAILBOX_SECRET_KEY; else process.env.MAILBOX_SECRET_KEY = saved.k;
    if (saved.s === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.s;
  });

  it("round-trips with MAILBOX_SECRET_KEY", () => {
    process.env.MAILBOX_SECRET_KEY = "test-key";
    const enc = encryptSecret("s3cr3t~value.with:colons");
    assert.match(enc, /^v1:[^:]+:[^:]+:[^:]+$/);
    assert.notEqual(encryptSecret("x"), encryptSecret("x")); // random IV
    assert.equal(decryptSecret(enc), "s3cr3t~value.with:colons");
  });

  it("falls back to the service-role key (HKDF)", () => {
    delete process.env.MAILBOX_SECRET_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    assert.equal(decryptSecret(encryptSecret("abc")), "abc");
  });

  it("fails clearly with the wrong key, a tampered value, or no key", () => {
    process.env.MAILBOX_SECRET_KEY = "one";
    const enc = encryptSecret("abc");
    process.env.MAILBOX_SECRET_KEY = "two";
    assert.throws(() => decryptSecret(enc), /could not be decrypted/);
    process.env.MAILBOX_SECRET_KEY = "one";
    const parts = enc.split(":");
    parts[3] = Buffer.from("zzz").toString("base64");
    assert.throws(() => decryptSecret(parts.join(":")), /could not be decrypted/);
    assert.throws(() => decryptSecret("plain"), /not a v1/);
    delete process.env.MAILBOX_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.throws(() => encryptSecret("abc"), /MAILBOX_SECRET_KEY/);
  });
});

describe("direction", () => {
  const msg = (address) => ({ from: { emailAddress: { address, name: "X" } } });
  it("is 'out' when from is the mailbox, case-insensitively", () => {
    assert.equal(detectDirection(msg("FreightSupport@FreightPOP.com"), MB, "inbox"), "out");
    assert.equal(detectDirection(msg(" freightsupport@freightpop.com "), MB, "sentitems"), "out");
  });
  it("is 'in' for anyone else, even in Sent Items", () => {
    assert.equal(detectDirection(msg("customer@acme.com"), MB, "inbox"), "in");
    assert.equal(detectDirection(msg("rep@freightpop.com"), MB, "sentitems"), "in");
  });
  it("falls back to the folder with no sender", () => {
    assert.equal(detectDirection({}, MB, "sentitems"), "out");
    assert.equal(detectDirection({ from: null }, MB, "inbox"), "in");
  });
});

describe("mapGraphMessage", () => {
  it("maps every selected field", () => {
    const g = {
      id: "AAk=", internetMessageId: "<m@x>", conversationId: "conv1", subject: "Where is my load?",
      from: { emailAddress: { name: "Cara Customer", address: "Cara@Acme.com" } },
      toRecipients: [{ emailAddress: { name: "Support", address: "FreightSupport@freightpop.com" } }],
      ccRecipients: [],
      receivedDateTime: "2026-11-19T10:00:00Z", sentDateTime: "2026-11-19T09:59:58Z",
      bodyPreview: "Hi team", hasAttachments: true, isRead: false, importance: "high",
      categories: ["Urgent"], webLink: "https://outlook.office365.com/owa/?ItemID=AAk%3D",
    };
    const row = mapGraphMessage(g, { connectionId: "c1", folder: "inbox", mailbox: MB, now: "2026-11-20T00:00:00Z" });
    assert.deepEqual(row, {
      connection_id: "c1", graph_id: "AAk=", internet_message_id: "<m@x>", conversation_id: "conv1", folder: "inbox",
      direction: "in", subject: "Where is my load?", from_address: "cara@acme.com", from_name: "Cara Customer",
      to_recipients: [{ name: "Support", address: "freightsupport@freightpop.com" }], cc_recipients: [],
      received_at: "2026-11-19T10:00:00Z", sent_at: "2026-11-19T09:59:58Z", body_preview: "Hi team",
      has_attachments: true, is_read: false, importance: "high", categories: ["Urgent"],
      web_link: "https://outlook.office365.com/owa/?ItemID=AAk%3D", removed_in_outlook: false, updated_at: "2026-11-20T00:00:00Z",
    });
    assert.ok(!("body_html" in row), "a sync must not overwrite the cached body");
  });
  it("tolerates missing fields", () => {
    const row = mapGraphMessage({ id: "x" }, { connectionId: "c1", folder: "sentitems", mailbox: MB });
    assert.equal(row.direction, "out");
    assert.equal(row.from_address, null);
    assert.deepEqual(row.to_recipients, []);
    assert.deepEqual(row.categories, []);
  });
});

describe("delta paging", () => {
  it("selects the contract's fields and resumes from next, then delta, then full history", () => {
    assert.equal(MESSAGE_SELECT, "id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,hasAttachments,isRead,importance,categories,webLink");
    assert.equal(initialDeltaPath(MB, "inbox"), `/users/${encodeURIComponent(MB)}/mailFolders/inbox/messages/delta?$select=${MESSAGE_SELECT}`);
    assert.equal(startUrlFor({ inbox: { next: "N", delta: "D" } }, MB, "inbox"), "N");
    assert.equal(startUrlFor({ inbox: { delta: "D" } }, MB, "inbox"), "D");
    assert.equal(startUrlFor({}, MB, "sentitems"), initialDeltaPath(MB, "sentitems"));
  });

  it("splits removed items from live ones", () => {
    const { upserts, removed } = splitDeltaItems([{ id: "a" }, { id: "b", "@removed": { reason: "deleted" } }, {}]);
    assert.deepEqual(upserts.map((m) => m.id), ["a"]);
    assert.deepEqual(removed, ["b"]);
  });

  const pagesFor = (pages) => {
    const calls = [];
    const graphFetchMock = async (url) => { calls.push(url); return pages[url]; };
    return { calls, graphFetchMock };
  };

  it("walks nextLinks to the deltaLink, saving after every page", async () => {
    const { calls, graphFetchMock } = pagesFor({
      start: { value: [{ id: "1" }], "@odata.nextLink": "p2" },
      p2: { value: [{ id: "2" }, { id: "3", "@removed": {} }], "@odata.nextLink": "p3" },
      p3: { value: [], "@odata.deltaLink": "D1" },
    });
    const seen = [];
    const saved = [];
    const r = await pageDelta({
      fetchPage: graphFetchMock, startUrl: "start", folderLinks: { delta: "OLD" },
      onPage: async (items) => { seen.push(items.map((i) => i.id)); },
      saveLinks: async (l) => { saved.push(l); },
    });
    assert.deepEqual(calls, ["start", "p2", "p3"]);
    assert.deepEqual(seen, [["1"], ["2", "3"], []]);
    assert.deepEqual(saved, [{ delta: "OLD", next: "p2" }, { delta: "OLD", next: "p3" }, { delta: "D1" }]);
    assert.deepEqual(r, { pages: 3, done: true, links: { delta: "D1" } });
  });

  it("stops at the time box with the nextLink saved, and resumes from it", async () => {
    const { calls, graphFetchMock } = pagesFor({
      start: { value: [{ id: "1" }], "@odata.nextLink": "p2" },
      p2: { value: [{ id: "2" }], "@odata.deltaLink": "D" },
    });
    let budget = 1;
    let links = {};
    const first = await pageDelta({
      fetchPage: graphFetchMock, startUrl: "start", onPage: async () => {},
      saveLinks: async (l) => { links = l; }, shouldStop: () => budget-- <= 0,
    });
    assert.deepEqual(first, { pages: 1, done: false, links: { next: "p2" } });
    assert.deepEqual(links, { next: "p2" });
    const second = await pageDelta({
      fetchPage: graphFetchMock, startUrl: startUrlFor({ inbox: links }, MB, "inbox"), folderLinks: links,
      onPage: async () => {}, saveLinks: async (l) => { links = l; },
    });
    assert.deepEqual(calls, ["start", "p2"]);
    assert.equal(second.done, true);
    assert.deepEqual(links, { delta: "D" });
  });

  it("does not save past a page whose items failed to store", async () => {
    const { graphFetchMock } = pagesFor({ start: { value: [{ id: "1" }], "@odata.nextLink": "p2" } });
    const saved = [];
    await assert.rejects(pageDelta({
      fetchPage: graphFetchMock, startUrl: "start",
      onPage: async () => { throw new Error("db down"); }, saveLinks: async (l) => { saved.push(l); },
    }), /db down/);
    assert.deepEqual(saved, []);
  });

  it("throws on a page with no link", async () => {
    await assert.rejects(pageDelta({
      fetchPage: async () => ({ value: [] }), startUrl: "s", onPage: async () => {}, saveLinks: async () => {},
    }), /neither/);
  });
});

describe("graphFetch", () => {
  const orig = { ..._deps };
  const conn = { tenant_id: "t", client_id: "c", client_secret: "s", mailbox: MB };
  let sleeps;
  beforeEach(() => { _clearTokenCache(); sleeps = []; _deps.sleep = async (ms) => { sleeps.push(ms); }; });
  afterEach(() => Object.assign(_deps, orig));

  const res = (status, body, headers = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body, text: async () => (body == null ? "" : JSON.stringify(body)),
  });

  it("builds urls and Prefer headers", () => {
    assert.equal(buildGraphUrl("/users/x"), "https://graph.microsoft.com/v1.0/users/x");
    assert.equal(buildGraphUrl("https://graph.microsoft.com/v1.0/next?x=1"), "https://graph.microsoft.com/v1.0/next?x=1");
    assert.equal(mergePrefer("odata.maxpagesize=100"), 'IdType="ImmutableId", odata.maxpagesize=100');
    assert.equal(parseRetryAfter("3"), 3000);
    assert.equal(parseRetryAfter(null), null);
  });

  it("retries 429 honoring Retry-After, sends ImmutableId, caches the token", async () => {
    const seen = [];
    let tokenCalls = 0;
    let n = 0;
    _deps.fetch = async (url, init) => {
      if (url.includes("login.microsoftonline.com")) { tokenCalls++; return res(200, { access_token: "tok", expires_in: 3600 }); }
      seen.push(init.headers);
      n++;
      return n === 1 ? res(429, { error: { message: "slow down" } }, { "retry-after": "7" }) : res(200, { value: [1] });
    };
    const out = await graphFetch(conn, "/users/x/messages", { headers: { Prefer: "odata.maxpagesize=100" } });
    assert.deepEqual(out, { value: [1] });
    assert.deepEqual(sleeps, [7000]);
    assert.equal(tokenCalls, 1);
    assert.equal(seen[1].Prefer, 'IdType="ImmutableId", odata.maxpagesize=100');
    assert.equal(seen[1].Authorization, "Bearer tok");
  });

  it("returns null for 202/204 and throws with .status and Graph's message", async () => {
    _deps.fetch = async (url) => (url.includes("login") ? res(200, { access_token: "tok", expires_in: 3600 })
      : url.endsWith("/a") ? res(202, null) : res(403, { error: { code: "ErrorAccessDenied", message: "Access is denied." } }));
    assert.equal(await graphFetch(conn, "/a", { method: "POST", body: {} }), null);
    await assert.rejects(graphFetch(conn, "/b"), (e) => e.status === 403 && e.message === "Access is denied.");
  });

  it("gives up after 6 tries", async () => {
    let n = 0;
    _deps.fetch = async (url) => (url.includes("login") ? res(200, { access_token: "tok", expires_in: 3600 }) : (n++, res(503, {})));
    await assert.rejects(graphFetch(conn, "/x"), (e) => e.status === 503);
    assert.equal(n, 6);
  });
});

describe("helpers", () => {
  it("publicConnection drops secrets", () => {
    assert.deepEqual(publicConnection({ id: 1, mailbox: MB, secret_enc: "v1:..", client_secret: "s", secret_hint: "abcd" }), { id: 1, mailbox: MB, secret_hint: "abcd" });
    assert.equal(publicConnection(null), null);
  });
  it("explains a refused mailbox in plain English", () => {
    assert.match(explainGraphError({ status: 403 }, MB), /role assignment.*up to 2 hours/s);
    assert.match(explainGraphError({ status: 401, source: "token", message: "Microsoft sign-in failed: bad secret" }, MB), /client secret/);
  });
  it("turns a text body into escaped HTML", () => {
    assert.equal(bodyToHtml({ contentType: "html", content: "<p>hi</p>" }), "<p>hi</p>");
    assert.match(bodyToHtml({ contentType: "text", content: "<b>&" }), /&lt;b&gt;&amp;/);
  });
});
