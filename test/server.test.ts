import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import type { Page } from "../src/webflow/types.js";
import { makeContext, PAGE_ID, SITE_ID } from "./helpers.js";

/** Minimal stateful fake of the page endpoints. */
function pageApi() {
  const page: Page = {
    id: PAGE_ID,
    siteId: SITE_ID,
    title: "Pricing",
    slug: "pricing",
    publishedPath: "/pricing",
    seo: { title: "Old title", description: "Old description" },
  };
  return (method: string, p: string, body: unknown) => {
    if (p === `sites/${SITE_ID}/pages` && method === "GET") {
      return { json: { pages: [page], pagination: { total: 1, limit: 100, offset: 0 } } };
    }
    if (p === `pages/${PAGE_ID}` && method === "GET") return { json: page };
    if (p === `pages/${PAGE_ID}` && method === "PUT") {
      Object.assign(page, body);
      return { json: page };
    }
    return undefined;
  };
}

async function connect(ctx: ReturnType<typeof makeContext>["ctx"]) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(ctx).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]!.text;
    return { isError: res.isError === true, text, data: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call };
}

describe("callisto MCP server", () => {
  it("exposes the expected tools", async () => {
    const { client } = await connect(makeContext(pageApi()).ctx);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "audit_query",
        "change_record",
        "client_overview",
        "clients_list",
        "cms_collections_list",
        "cms_item_update",
        "cms_items_find",
        "code_list",
        "code_remove",
        "code_upsert",
        "page_content_snapshot",
        "page_meta_update",
        "pages_list",
        "site_publish",
        "snapshot_restore",
        "verify_live",
      ].sort(),
    );
  });

  it("runs dry run -> confirm -> audit -> restore for page settings", async () => {
    const { ctx, calls } = makeContext(pageApi());
    const { call } = await connect(ctx);
    const args = { client: "acme", page: "/pricing", seo: { title: "New title" } };

    const plan = await call("page_meta_update", args);
    expect(plan.data).toMatchObject({ status: "planned", changes: [{ path: "seo.title", before: "Old title", after: "New title" }] });
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);

    const applied = await call("page_meta_update", { ...args, confirm: true, planId: plan.data.planId });
    expect(applied.data.status).toBe("applied");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ seo: { title: "New title", description: "Old description" } });

    const again = await call("page_meta_update", args);
    expect(again.data.status).toBe("noop");

    const audit = await call("audit_query", { client: "acme" });
    expect(audit.data[0]).toMatchObject({ kind: "page.meta", status: "applied", changeCount: 1 });

    const restorePlan = await call("snapshot_restore", { snapshotId: applied.data.snapshotId });
    expect(restorePlan.data.changes).toEqual([{ path: "seo.title", before: "New title", after: "Old title" }]);
    const restored = await call("snapshot_restore", {
      snapshotId: applied.data.snapshotId,
      confirm: true,
      planId: restorePlan.data.planId,
    });
    expect(restored.data.status).toBe("applied");
    expect((await call("pages_list", { client: "acme" })).data[0].seoTitle).toBe("Old title");
  });

  it("rejects a stale or mismatched planId without writing", async () => {
    const { ctx, calls } = makeContext(pageApi());
    const { call } = await connect(ctx);
    const plan = await call("page_meta_update", { client: "acme", page: PAGE_ID, title: "A" });
    const res = await call("page_meta_update", { client: "acme", page: PAGE_ID, title: "B", confirm: true, planId: plan.data.planId });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/planId does not match/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refuses to write for read-only clients", async () => {
    const { ctx, calls } = makeContext(pageApi(), { readOnly: true });
    const { call } = await connect(ctx);
    const plan = await call("page_meta_update", { client: "acme", page: "pricing", title: "X" });
    const res = await call("page_meta_update", { client: "acme", page: "pricing", title: "X", confirm: true, planId: plan.data.planId });
    expect(res.text).toMatch(/readOnly/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("reports unknown clients clearly", async () => {
    const { call } = await connect(makeContext(pageApi()).ctx);
    const res = await call("pages_list", { client: "globex" });
    expect(res).toMatchObject({ isError: true });
    expect(res.text).toMatch(/Unknown client "globex". Known clients: acme/);
  });
});
