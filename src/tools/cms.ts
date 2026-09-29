import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext, ResolvedClient } from "../context.js";
import { guardedWrite } from "../core/guard.js";
import { applyFieldPatch, cmsItemOp } from "../operations/cms-item.js";
import type { Collection, CollectionItem } from "../webflow/types.js";
import { clientArg, confirmArg, OBJECT_ID, ok, planIdArg, safe } from "./shared.js";

const collectionArg = z.string().min(1).describe("Collection id, slug or display name.");

async function resolveCollection(client: ResolvedClient, ref: string): Promise<Collection> {
  const key = ref.trim().toLowerCase();
  let id = OBJECT_ID.test(key) ? key : undefined;
  if (!id) {
    const { collections } = await client.api.get<{ collections: Collection[] }>(
      `sites/${client.config.siteId}/collections`,
    );
    const match = collections.filter(
      (c) => c.slug.toLowerCase() === key || c.displayName.toLowerCase() === key || c.singularName.toLowerCase() === key,
    );
    if (match.length !== 1) {
      const names = collections.map((c) => `${c.displayName} (${c.slug})`).join(", ");
      throw new Error(`Collection "${ref}" ${match.length ? "is ambiguous" : "not found"}. Available: ${names}`);
    }
    id = match[0]!.id;
  }
  // The detail endpoint includes the field schema.
  return client.api.get<Collection>(`collections/${id}`);
}

async function resolveItemId(client: ResolvedClient, collectionId: string, ref: string, cmsLocaleId?: string) {
  if (OBJECT_ID.test(ref)) return ref;
  // Filter client-side: exact slug match is required and must not depend on server-side filter support.
  const all = await client.api.paginate<CollectionItem>(`collections/${collectionId}/items`, "items", { cmsLocaleId });
  const items = all.filter((i) => i.fieldData.slug === ref);
  if (items.length !== 1) throw new Error(`Item with slug "${ref}" ${items.length ? "is ambiguous" : "not found"}.`);
  return items[0]!.id;
}

export function registerCmsTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "cms_collections_list",
    {
      title: "List CMS collections",
      description: "List a client's CMS collections, optionally with each collection's field schema (slug, type, required).",
      inputSchema: { client: clientArg, withFields: z.boolean().default(false) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ client: alias, withFields }) => {
      const client = ctx.client(alias);
      const { collections } = await client.api.get<{ collections: Collection[] }>(
        `sites/${client.config.siteId}/collections`,
      );
      const detailed = withFields
        ? await Promise.all(collections.map((c) => client.api.get<Collection>(`collections/${c.id}`)))
        : collections;
      return ok(
        detailed.map((c) => ({
          id: c.id,
          name: c.displayName,
          slug: c.slug,
          ...(withFields
            ? {
                fields: (c.fields ?? []).map((f) => ({
                  slug: f.slug,
                  name: f.displayName,
                  type: f.type,
                  required: f.isRequired ?? false,
                  editable: f.isEditable ?? true,
                })),
              }
            : {}),
        })),
      );
    }),
  );

  server.registerTool(
    "cms_items_find",
    {
      title: "Find CMS items",
      description: "Search a collection's items by name or slug. Returns compact rows; pass fields to include specific field values.",
      inputSchema: {
        client: clientArg,
        collection: collectionArg,
        search: z.string().optional().describe("Case-insensitive match against name and slug."),
        fields: z.array(z.string()).optional().describe("Field slugs to include in each row."),
        cmsLocaleId: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ client: alias, collection, search, fields, cmsLocaleId, limit }) => {
      const client = ctx.client(alias);
      const col = await resolveCollection(client, collection);
      const needle = search?.toLowerCase();
      const items = await client.api.paginate<CollectionItem>(`collections/${col.id}/items`, "items", { cmsLocaleId });
      const rows = items
        .filter((i) => {
          if (!needle) return true;
          const { name, slug } = i.fieldData as { name?: string; slug?: string };
          return [name, slug].some((v) => v?.toLowerCase().includes(needle));
        })
        .slice(0, limit)
        .map((i) => ({
          id: i.id,
          name: i.fieldData.name ?? null,
          slug: i.fieldData.slug ?? null,
          isDraft: i.isDraft ?? false,
          isArchived: i.isArchived ?? false,
          lastUpdated: i.lastUpdated ?? null,
          ...(fields?.length ? { fieldData: Object.fromEntries(fields.map((f) => [f, i.fieldData[f] ?? null])) } : {}),
        }));
      return ok({ collection: { id: col.id, name: col.displayName }, matched: rows.length, items: rows });
    }),
  );

  server.registerTool(
    "cms_item_update",
    {
      title: "Update a CMS item",
      description:
        "Guarded, field-level update of one CMS item (staged until site_publish). Field slugs are validated against the " +
        "collection schema; null clears a field. First call is a dry run returning a diff and planId.",
      inputSchema: {
        client: clientArg,
        collection: collectionArg,
        item: z.string().min(1).describe("Item id or slug."),
        fields: z.record(z.string(), z.unknown()).describe("Map of field slug to new value."),
        cmsLocaleId: z.string().optional(),
        confirm: confirmArg,
        planId: planIdArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ client: alias, collection, item, fields, cmsLocaleId, confirm, planId }) => {
      const client = ctx.client(alias);
      const col = await resolveCollection(client, collection);
      const schema = new Map((col.fields ?? []).map((f) => [f.slug, f]));
      const unknown = Object.keys(fields).filter((k) => !schema.has(k));
      if (unknown.length) {
        throw new Error(`Unknown field(s) ${unknown.join(", ")} for ${col.displayName}. Valid: ${[...schema.keys()].join(", ")}`);
      }
      const readOnly = Object.keys(fields).filter((k) => schema.get(k)?.isEditable === false);
      if (readOnly.length) throw new Error(`Field(s) ${readOnly.join(", ")} are not editable.`);

      const itemId = await resolveItemId(client, col.id, item, cmsLocaleId);
      const result = await guardedWrite({
        ctx,
        clientAlias: alias,
        op: cmsItemOp,
        target: { collectionId: col.id, itemId, ...(cmsLocaleId ? { cmsLocaleId } : {}) },
        propose: (before) => applyFieldPatch(before, fields),
        confirm,
        planId,
        summary: `Update ${col.singularName} "${item}" fields: ${Object.keys(fields).join(", ")}`,
      });
      return ok(result);
    }),
  );
}
