import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { guardedWrite } from "../core/guard.js";
import { applyPageMetaPatch, pageMetaOp } from "../operations/page-meta.js";
import type { DomNode } from "../webflow/types.js";
import { clientArg, confirmArg, listPages, ok, pageArg, planIdArg, resolvePage, safe } from "./shared.js";

const nullableText = z.string().nullable();

export function registerPageTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "pages_list",
    {
      title: "List pages",
      description: "List a client's pages with id, title, slug, published path and SEO fields. Optionally filter by text.",
      inputSchema: {
        client: clientArg,
        search: z.string().optional().describe("Case-insensitive match against title, slug or path."),
        includeTemplates: z.boolean().default(false).describe("Include CMS collection template pages."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ client: alias, search, includeTemplates }) => {
      const client = ctx.client(alias);
      const needle = search?.toLowerCase();
      const pages = (await listPages(client))
        .filter((p) => includeTemplates || !p.collectionId)
        .filter(
          (p) => !needle || [p.title, p.slug, p.publishedPath].some((v) => v?.toLowerCase().includes(needle)),
        );
      return ok(
        pages.map((p) => ({
          id: p.id,
          title: p.title,
          slug: p.slug,
          path: p.publishedPath ?? null,
          draft: p.draft ?? false,
          collectionId: p.collectionId ?? null,
          seoTitle: p.seo?.title ?? null,
          seoDescription: p.seo?.description ?? null,
        })),
      );
    }),
  );

  server.registerTool(
    "page_meta_update",
    {
      title: "Update page title, slug, SEO and Open Graph",
      description:
        "Guarded update of a page's settings. First call returns a diff and planId (dry run); call again with " +
        "confirm: true and the planId to apply. Changes are staged until site_publish. Only provided fields change.",
      inputSchema: {
        client: clientArg,
        page: pageArg,
        localeId: z.string().optional().describe("Secondary locale id; omit for the primary locale."),
        title: z.string().min(1).optional(),
        slug: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case")
          .optional()
          .describe("Changing a slug changes the URL: add a 301 redirect in Webflow."),
        seo: z.object({ title: nullableText.optional(), description: nullableText.optional() }).optional(),
        openGraph: z
          .object({
            title: nullableText.optional(),
            titleCopied: z.boolean().optional(),
            description: nullableText.optional(),
            descriptionCopied: z.boolean().optional(),
          })
          .optional(),
        confirm: confirmArg,
        planId: planIdArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ client: alias, page, localeId, title, slug, seo, openGraph, confirm, planId }) => {
      const client = ctx.client(alias);
      const resolved = await resolvePage(client, page);
      const result = await guardedWrite({
        ctx,
        clientAlias: alias,
        op: pageMetaOp,
        target: { pageId: resolved.id, ...(localeId ? { localeId } : {}) },
        propose: (before) => applyPageMetaPatch(before, { title, slug, seo, openGraph }),
        confirm,
        planId,
        summary: `Update settings of page "${resolved.title}" (${resolved.publishedPath ?? resolved.slug})`,
      });
      return ok(result);
    }),
  );

  server.registerTool(
    "page_content_snapshot",
    {
      title: "Snapshot page content",
      description:
        "Capture a page's static content nodes (text, images, component props) to a local snapshot and return the text " +
        "nodes. Run before and after element edits made through the official Webflow MCP so every edit has a " +
        "before/after record. Read-only against Webflow.",
      inputSchema: {
        client: clientArg,
        page: pageArg,
        localeId: z.string().optional(),
        maxTextNodes: z.number().int().min(0).max(1000).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ client: alias, page, localeId, maxTextNodes }) => {
      const client = ctx.client(alias);
      const resolved = await resolvePage(client, page);
      const nodes = await client.api.paginate<DomNode>(`pages/${resolved.id}/dom`, "nodes", { localeId });
      const snapshot = await ctx.snapshots.save({
        client: client.config.alias,
        kind: "page.dom",
        target: { pageId: resolved.id, localeId },
        before: nodes,
      });
      await ctx.audit.append({
        client: client.config.alias,
        kind: "page.dom.snapshot",
        status: "recorded",
        source: "callisto",
        target: { pageId: resolved.id, localeId },
        summary: `Snapshot of page "${resolved.title}" (${nodes.length} nodes)`,
        snapshotId: snapshot.id,
      });
      const textNodes = nodes
        .filter((n) => n.text?.text)
        .slice(0, maxTextNodes)
        .map((n) => ({ id: n.id, text: n.text?.text }));
      return ok({
        snapshotId: snapshot.id,
        page: { id: resolved.id, title: resolved.title, path: resolved.publishedPath ?? null },
        nodeCount: nodes.length,
        textNodes,
      });
    }),
  );
}
