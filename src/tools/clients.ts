import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import type { Collection, Site } from "../webflow/types.js";
import { clientArg, listPages, ok, safe } from "./shared.js";

export function registerClientTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "clients_list",
    {
      title: "List Callisto clients",
      description:
        "List every customer site in the Callisto registry with its alias, Webflow siteId, live URL and write status. " +
        "Start here to resolve a customer name to an alias and siteId (the siteId can also be passed to the official Webflow MCP).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () =>
      ok(
        ctx.clients.map((c) => ({
          alias: c.alias,
          name: c.name,
          siteId: c.siteId,
          liveUrl: c.liveUrl ?? null,
          readOnly: c.readOnly,
          notes: c.notes ?? null,
        })),
      ),
    ),
  );

  server.registerTool(
    "client_overview",
    {
      title: "Client site overview",
      description:
        "Summarize a client's Webflow site: domains, locales, last publish, page and collection inventory, and Callisto " +
        "changes applied since the last publish (i.e. what the next publish would ship).",
      inputSchema: { client: clientArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ client: alias }) => {
      const client = ctx.client(alias);
      const siteId = client.config.siteId;
      const [site, pages, collections] = await Promise.all([
        client.api.get<Site>(`sites/${siteId}`),
        listPages(client),
        client.api.get<{ collections: Collection[] }>(`sites/${siteId}/collections`),
      ]);
      const unpublished = await ctx.audit.changesSince(client.config.alias, site.lastPublished);
      return ok({
        client: { alias: client.config.alias, name: client.config.name, readOnly: client.config.readOnly },
        site: {
          id: site.id,
          name: site.displayName,
          shortName: site.shortName,
          lastPublished: site.lastPublished ?? null,
          lastUpdated: site.lastUpdated ?? null,
          customDomains: (site.customDomains ?? []).map((d) => d.url),
          locales: site.locales ?? null,
        },
        pages: {
          total: pages.length,
          static: pages.filter((p) => !p.collectionId).length,
          templates: pages.filter((p) => p.collectionId).length,
          drafts: pages.filter((p) => p.draft).length,
        },
        collections: collections.collections.map((c) => ({ id: c.id, name: c.displayName, slug: c.slug })),
        changesSinceLastPublish: unpublished.map((e) => ({ ts: e.ts, kind: e.kind, source: e.source, summary: e.summary })),
      });
    }),
  );
}
