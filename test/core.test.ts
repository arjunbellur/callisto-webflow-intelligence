import { describe, expect, it } from "vitest";
import { parseRegistry } from "../src/config.js";
import { diff, hash, stableStringify } from "../src/core/diff.js";
import { checkLivePage, decodeEntities } from "../src/core/verify.js";
import { upsertScript } from "../src/operations/custom-code.js";
import { applyPageMetaPatch, toPageMetaState } from "../src/operations/page-meta.js";
import { WebflowClient } from "../src/webflow/client.js";
import { WebflowApiError } from "../src/webflow/errors.js";
import { fakeFetch, PAGE_ID, SITE_ID } from "./helpers.js";

describe("diff", () => {
  it("walks objects into dotted paths and treats null/undefined as equal", () => {
    expect(diff({ a: 1, seo: { title: "x", description: null } }, { a: 1, seo: { title: "y" } })).toEqual([
      { path: "seo.title", before: "x", after: "y" },
    ]);
  });

  it("compares arrays as whole values", () => {
    expect(diff({ s: [1, 2] }, { s: [2, 1] })).toHaveLength(1);
  });

  it("hashes independently of key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(hash({ x: 1, y: 2 })).toBe(hash({ y: 2, x: 1 }));
  });
});

describe("page meta", () => {
  const state = toPageMetaState({ id: PAGE_ID, siteId: SITE_ID, title: "About", slug: "about" });

  it("marks OG fields as no longer copied when set explicitly", () => {
    const next = applyPageMetaPatch(state, { openGraph: { title: "OG" } });
    expect(next.openGraph).toMatchObject({ title: "OG", titleCopied: false, descriptionCopied: true });
  });

  it("leaves untouched fields alone", () => {
    expect(applyPageMetaPatch(state, { seo: { description: "d" } })).toEqual({
      ...state,
      seo: { title: null, description: "d" },
    });
  });
});

describe("upsertScript", () => {
  const registered = [
    { id: "r1", displayName: "GA4", version: "1.0.0" },
    { id: "r2", displayName: "Pixel", version: "1.0.0" },
  ];
  const current = [
    { id: "r1", location: "header" as const, version: "1.0.0" },
    { id: "r2", location: "footer" as const, version: "1.0.0" },
  ];

  it("replaces an applied older version in place and keeps other scripts", () => {
    const { next, reused } = upsertScript({ current, registered, displayName: "GA4", version: "1.1.0", location: "header" });
    expect(reused).toBeUndefined();
    expect(next).toEqual([{ id: "pending:GA4@1.1.0", location: "header", version: "1.1.0" }, current[1]]);
  });

  it("reuses a registered script with the same name and version", () => {
    const { next, reused } = upsertScript({ current: [], registered, displayName: "Pixel", version: "1.0.0", location: "footer" });
    expect(reused?.id).toBe("r2");
    expect(next).toEqual([{ id: "r2", location: "footer", version: "1.0.0" }]);
  });
});

describe("registry", () => {
  it("rejects duplicate aliases and malformed site ids", () => {
    expect(() =>
      parseRegistry({
        clients: [
          { alias: "acme", name: "A", siteId: SITE_ID },
          { alias: "acme", name: "B", siteId: "nope" },
        ],
      }),
    ).toThrow(/24-character[\s\S]*duplicate alias/);
  });
});

describe("WebflowClient", () => {
  it("retries 429 responses honoring Retry-After", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const { impl } = fakeFetch(() => (++n < 3 ? { status: 429, json: { message: "slow down" } } : { json: { ok: true } }));
    const client = new WebflowClient({ token: "t", fetchImpl: impl, sleep: async (ms) => void sleeps.push(ms) });
    await expect(client.post("sites/x/publish", {})).resolves.toEqual({ ok: true });
    expect(n).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry non-idempotent requests on 5xx", async () => {
    let n = 0;
    const { impl } = fakeFetch(() => (n++, { status: 502, json: { code: "bad_gateway", message: "upstream" } }));
    const client = new WebflowClient({ token: "t", fetchImpl: impl, sleep: async () => {} });
    const err = await client.patch("collections/x/items", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebflowApiError);
    expect((err as WebflowApiError).code).toBe("bad_gateway");
    expect(n).toBe(1);
  });

  it("paginates until the total is reached", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: String(i) }));
    const { impl, calls } = fakeFetch((_m, p) => (p === "things" ? { json: {} } : undefined));
    const client = new WebflowClient({
      token: "t",
      sleep: async () => {},
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        await impl(input, init);
        const url = new URL(String(input));
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        return new Response(JSON.stringify({ items: all.slice(offset, offset + limit), pagination: { total: 5 } }));
      }) as typeof fetch,
    });
    expect(await client.paginate("things", "items", {}, 2)).toEqual(all);
    expect(calls).toHaveLength(3);
  });
});

describe("verify", () => {
  it("decodes entities and evaluates checks", async () => {
    expect(decodeEntities("Acme &amp; Co &#8212; &#x27;hi&#x27;")).toBe("Acme & Co — 'hi'");
    const html =
      '<html><head><title>Acme &amp; Co</title><meta name="description" content="Best widgets">' +
      '<meta property="og:title" content="Acme"></head><body>New hero copy</body></html>';
    const fetchImpl = (async () => new Response(html)) as unknown as typeof fetch;
    const res = await checkLivePage(new URL("https://acme.test/"), ["Acme & Co", "New hero copy"], ["Old copy"], fetchImpl);
    expect(res).toMatchObject({ ok: true, title: "Acme & Co", metaDescription: "Best widgets", ogTitle: "Acme" });
  });
});
