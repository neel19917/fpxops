import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  _deps, _resetState, _resetBucket, normalizeCid, sanitizeCid, extractCids, matchCid, replaceCids, pickAttachments,
  storagePathFor, cacheInlineImages, rewriteCidImages, withInlineImages, BUCKET, TABLE, MAX_IMAGE_BYTES, SIGNED_URL_SECONDS,
} from "../lib/mailbox/images.js";

const MID = "11111111-2222-3333-4444-555555555555";
const CONN = { mailbox: "freightsupport@freightpop.com", tenant_id: "t", client_id: "c", client_secret: "s" };

// In-memory Supabase stand-in: one table + one bucket.
function fakeSupabase({ tableMissing = false } = {}) {
  const state = { rows: [], objects: new Map(), buckets: new Set(), signCalls: [], uploads: 0, listCalls: 0 };
  const missingErr = { code: "42P01", message: `relation "${TABLE}" does not exist` };
  const sb = {
    state,
    from(table) {
      assert.equal(table, TABLE);
      return {
        select() {
          return {
            eq: async (_col, val) => tableMissing
              ? { data: null, error: missingErr }
              : { data: state.rows.filter((r) => r.message_id === val).map(({ content_id, storage_path }) => ({ content_id, storage_path })), error: null },
          };
        },
        upsert: async (records) => {
          if (tableMissing) return { error: missingErr };
          for (const r of records) {
            state.rows = state.rows.filter((x) => !(x.message_id === r.message_id && x.content_id === r.content_id));
            state.rows.push(r);
          }
          return { error: null };
        },
      };
    },
    storage: {
      getBucket: async (name) => state.buckets.has(name) ? { data: { name }, error: null } : { data: null, error: { message: "Bucket not found" } },
      createBucket: async (name, opts) => { assert.equal(opts.public, false); state.buckets.add(name); return { data: { name }, error: null }; },
      from(bucket) {
        assert.equal(bucket, BUCKET);
        return {
          upload: async (path, buf) => { state.uploads++; state.objects.set(path, buf); return { data: { path }, error: null }; },
          list: async (prefix) => {
            state.listCalls++;
            return {
              data: [...state.objects.keys()].filter((k) => k.startsWith(`${prefix}/`)).map((k) => ({ name: k.slice(prefix.length + 1), id: "x" })),
              error: null,
            };
          },
          createSignedUrls: async (paths, secs) => {
            state.signCalls.push({ paths, secs });
            return { data: paths.map((p) => ({ path: p, signedUrl: `https://x.supabase.co/sign/${p}?t=1`, error: null })), error: null };
          },
        };
      },
    },
  };
  return sb;
}

function fakeGraph(attachments) {
  const calls = [];
  const fn = async (_conn, path) => {
    calls.push(path);
    // The list call (no attachment id). Like Graph, it may omit contentBytes
    // for an item; those are fetched one by one.
    if (/\/attachments$/.test(path)) return { value: attachments.map(({ contentBytes, listBytes, ...a }) => (listBytes ? { ...a, contentBytes } : a)) };
    const id = decodeURIComponent(path.split("/attachments/")[1]);
    const a = attachments.find((x) => x.id === id);
    return a ? { ...a } : null;
  };
  fn.calls = calls;
  return fn;
}

const png = Buffer.from("fake-png").toString("base64");

describe("cid parsing", () => {
  it("normalizes <>, cid: prefix, case and url-encoding", () => {
    assert.equal(normalizeCid("<Image001.PNG@01DA.ABC>"), "image001.png@01da.abc");
    assert.equal(normalizeCid("cid:image001.png%4001DA"), "image001.png@01da");
    assert.equal(normalizeCid(" <abc> "), "abc");
  });

  it("sanitizes to a safe Storage name", () => {
    assert.equal(sanitizeCid("<a b/c?d@x.y>"), "a_b_c_d@x.y");
    assert.equal(sanitizeCid("../etc"), "__etc");
    assert.equal(storagePathFor(MID, "<Img@X>"), `${MID}/img@x`);
  });

  it("extracts distinct cids from src (quoted or not), background and css url()", () => {
    const html = `<img src="cid:image001.png@01DA"><img SRC='cid:Image001.png@01da'><img src=cid:logo>
      <td background="cid:bg.jpg"></td><div style="background:url('cid:pat@x')"></div><a href="cid:nope">x</a>`;
    assert.deepEqual(extractCids(html), ["image001.png@01da", "logo", "bg.jpg", "pat@x"]);
    assert.deepEqual(extractCids(""), []);
    assert.deepEqual(extractCids(null), []);
  });

  it("matches with or without the @domain part, case-insensitively", () => {
    const entries = [{ content_id: "image001.png@01da.abc" }, { content_id: "logo" }];
    assert.equal(matchCid("IMAGE001.PNG@01DA.ABC", entries), entries[0]);
    assert.equal(matchCid("image001.png", entries), entries[0]);
    assert.equal(matchCid("<logo@company.com>", entries), entries[1]);
    assert.equal(matchCid("image001.png@other", entries), null); // different domain: not the same image
    assert.equal(matchCid("missing", entries), null);
  });

  it("matches sanitized Storage names", () => {
    const entries = [{ content_id: "a_b@x" }];
    assert.equal(matchCid("a b@x", entries), entries[0]);
  });

  it("replaces only resolvable cids and keeps quotes", () => {
    const html = `<img src="cid:a@x"><img src='cid:b'><img src=cid:c><div style="background:url(cid:a@x)">`;
    const out = replaceCids(html, (cid) => (normalizeCid(cid) === "a@x" ? "https://u/a?t=1&s=2" : normalizeCid(cid) === "c" ? "https://u/c" : null));
    assert.equal(out, `<img src="https://u/a?t=1&s=2"><img src='cid:b'><img src="https://u/c"><div style="background:url(https://u/a?t=1&s=2)">`);
  });
});

describe("pickAttachments", () => {
  it("keeps referenced or inline images, skips big, non-file and unrelated ones, caps the count", () => {
    const html = `<img src="cid:ref.png">`;
    const list = [
      { id: "1", contentId: "<ref.png@01>", contentType: "image/png", size: 10, isInline: false },
      { id: "2", contentId: "inl", contentType: "image/jpeg", size: 10, isInline: true },
      { id: "3", contentId: "doc", contentType: "application/pdf", size: 10, isInline: false },
      { id: "4", contentId: "big", contentType: "image/png", size: MAX_IMAGE_BYTES + 1, isInline: true },
      { id: "5", contentId: "item", contentType: "image/png", size: 1, isInline: true, "@odata.type": "#microsoft.graph.itemAttachment" },
      { id: "6", contentType: "image/png", size: 1, isInline: true },
    ];
    assert.deepEqual(pickAttachments(list, html).map((a) => a.id), ["1", "2"]);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: String(i), contentId: `c${i}`, contentType: "image/png", size: 1, isInline: true }));
    assert.equal(pickAttachments(many, "").length, 30);
  });
});

describe("cache + rewrite", () => {
  let sb;
  beforeEach(() => { _resetState(); _resetBucket(); sb = fakeSupabase(); _deps.supabase = sb; });

  const row = (html) => ({ id: MID, graph_id: "AAMk/1=", body_html: html });

  it("first open fetches and stores; later opens only re-sign", async () => {
    const graph = fakeGraph([
      { id: "att1", contentId: "<image001.png@01DA>", contentType: "image/png", size: 8, isInline: true, contentBytes: png },
      { id: "att2", contentId: "other", contentType: "application/pdf", size: 8, isInline: false, contentBytes: png },
    ]);
    _deps.graphFetch = graph;
    const html = `<p>Hi</p><img src="cid:image001.png@01DA"><img src="cid:gone">`;

    const out1 = await withInlineImages(async () => CONN, row(html));
    assert.equal(out1, `<p>Hi</p><img src="https://x.supabase.co/sign/${MID}/image001.png@01da?t=1"><img src="cid:gone">`);
    assert.ok(sb.state.buckets.has(BUCKET));
    assert.equal(sb.state.uploads, 1);
    assert.equal(sb.state.rows.length, 1);
    assert.deepEqual(sb.state.rows[0], { message_id: MID, content_id: "image001.png@01da", storage_path: `${MID}/image001.png@01da`, content_type: "image/png", size: 8 });
    assert.match(graph.calls[0], /\/users\/freightsupport%40freightpop\.com\/messages\/AAMk%2F1%3D\/attachments$/);
    assert.equal(graph.calls.length, 2);
    assert.equal(sb.state.signCalls[0].secs, SIGNED_URL_SECONDS);

    // A fresh process (state reset) still finds the cache and does not call Graph.
    _resetState();
    const out2 = await withInlineImages(async () => { throw new Error("must not load conn"); }, row(html));
    assert.equal(out2, out1);
    assert.equal(graph.calls.length, 2);
    assert.equal(sb.state.uploads, 1);
    assert.equal(sb.state.signCalls.length, 2);
  });

  it("uses contentBytes from the list call when Graph includes them", async () => {
    const graph = fakeGraph([{ id: "a", contentId: "logo.png@01X", contentType: "image/png", size: 8, isInline: true, contentBytes: png, listBytes: true }]);
    _deps.graphFetch = graph;
    const out = await withInlineImages(CONN, row(`<img src="cid:logo.png@01X">`));
    assert.equal(out, `<img src="https://x.supabase.co/sign/${MID}/logo.png@01x?t=1">`);
    assert.equal(graph.calls.length, 1);
    assert.equal(sb.state.uploads, 1);
  });

  it("matches html cid without @domain to an attachment with one", async () => {
    _deps.graphFetch = fakeGraph([{ id: "a", contentId: "logo.png@01X", contentType: "image/png", size: 8, isInline: true, contentBytes: png }]);
    const out = await withInlineImages(CONN, row(`<img src="cid:LOGO.png">`));
    assert.equal(out, `<img src="https://x.supabase.co/sign/${MID}/logo.png@01x?t=1">`);
  });

  it("does not fetch the same message twice at once", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const inner = fakeGraph([{ id: "a", contentId: "x", contentType: "image/png", size: 8, isInline: true, contentBytes: png }]);
    let listCalls = 0;
    _deps.graphFetch = async (c, p) => { if (/\/attachments$/.test(p)) { listCalls++; await gate; } return inner(c, p); };
    const r = row(`<img src="cid:x">`);
    const p1 = cacheInlineImages(CONN, r);
    const p2 = cacheInlineImages(CONN, r);
    release();
    await Promise.all([p1, p2]);
    assert.equal(listCalls, 1);
    assert.equal(sb.state.uploads, 1);
    await cacheInlineImages(CONN, r); // already done this process
    assert.equal(listCalls, 1);
  });

  it("never throws when Graph fails; html is returned unchanged", async () => {
    _deps.graphFetch = async () => { throw Object.assign(new Error("boom"), { status: 500 }); };
    const html = `<img src="cid:x">`;
    await assert.doesNotReject(cacheInlineImages(CONN, row(html)));
    _resetState();
    assert.equal(await withInlineImages(CONN, row(html)), html);
  });

  it("works without the DB table, signing Storage paths found by listing", async () => {
    sb = fakeSupabase({ tableMissing: true });
    _deps.supabase = sb;
    _deps.graphFetch = fakeGraph([{ id: "a", contentId: "<Pic 1@d>", contentType: "image/png", size: 8, isInline: true, contentBytes: png }]);
    const html = `<img src="cid:pic 1@d">`.replace("pic 1", "pic%201");
    const out = await withInlineImages(CONN, row(html));
    assert.equal(out, `<img src="https://x.supabase.co/sign/${MID}/pic_1@d?t=1">`);
    assert.equal(sb.state.rows.length, 0);
  });

  it("rewrite leaves html alone with nothing cached or no cids", async () => {
    assert.equal(await rewriteCidImages(`<img src="cid:x">`, row("")), `<img src="cid:x">`);
    assert.equal(await rewriteCidImages(`<img src="https://a/b.png">`, row("")), `<img src="https://a/b.png">`);
    assert.equal(sb.state.signCalls.length, 0);
  });

  it("html without cid: refs passes straight through", async () => {
    _deps.graphFetch = async () => { throw new Error("no graph"); };
    assert.equal(await withInlineImages(CONN, row(`<p>plain</p>`)), `<p>plain</p>`);
  });
});
