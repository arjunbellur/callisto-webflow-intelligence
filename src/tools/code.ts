import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext, ResolvedClient } from "../context.js";
import { guardedWrite } from "../core/guard.js";
import { type CustomCodeTarget, customCodeOp, upsertScript } from "../operations/custom-code.js";
import type { RegisteredScript } from "../webflow/types.js";
import { clientArg, confirmArg, ok, pageArg, planIdArg, resolvePage, safe } from "./shared.js";

const scopeArgs = {
  scope: z.enum(["site", "page"]).describe("Apply to the whole site or a single page."),
  page: pageArg.optional().describe("Required when scope is 'page'."),
};

async function listRegistered(client: ResolvedClient): Promise<RegisteredScript[]> {
  const res = await client.api.get<{ registeredScripts?: RegisteredScript[] }>(
    `sites/${client.config.siteId}/registered_scripts`,
  );
  return res.registeredScripts ?? [];
}

async function resolveTarget(client: ResolvedClient, scope: "site" | "page", page?: string) {
  const siteId = client.config.siteId;
  if (scope === "site") return { target: { scope, siteId } as CustomCodeTarget, label: "site" };
  if (!page) throw new Error("page is required when scope is 'page'.");
  const resolved = await resolvePage(client, page);
  return {
    target: { scope, siteId, pageId: resolved.id } as CustomCodeTarget,
    label: `page "${resolved.title}"`,
  };
}

export function registerCodeTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "code_list",
    {
      title: "List custom code",
      description: "List scripts registered on a client's site and which are applied site-wide (and to a page, if given).",
      inputSchema: { client: clientArg, page: pageArg.optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ client: alias, page }) => {
      const client = ctx.client(alias);
      const registered = await listRegistered(client);
      const byId = new Map(registered.map((r) => [r.id, r]));
      const describe = (list: { id: string; location: string; version: string }[]) =>
        list.map((s) => ({ ...s, displayName: byId.get(s.id)?.displayName ?? null }));

      const site = await customCodeOp.read(client, { scope: "site", siteId: client.config.siteId });
      const pageTarget = page ? await resolveTarget(client, "page", page) : undefined;
      const pageScripts = pageTarget ? await customCodeOp.read(client, pageTarget.target) : undefined;
      return ok({
        registered: registered.map((r) => ({ id: r.id, displayName: r.displayName, version: r.version })),
        appliedToSite: describe(site),
        ...(pageScripts ? { appliedToPage: describe(pageScripts) } : {}),
      });
    }),
  );

  server.registerTool(
    "code_upsert",
    {
      title: "Add or update an inline script",
      description:
        "Guarded upsert of an inline script (tracking pixels, analytics, schema helpers) on the site or a page, matched " +
        "by displayName: an applied older version is replaced in place, otherwise it is added. Other applied scripts " +
        "are preserved. The script is only registered with Webflow on confirm. Pass JavaScript without <script> tags.",
      inputSchema: {
        client: clientArg,
        ...scopeArgs,
        displayName: z.string().min(1).max(50),
        version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver, e.g. 1.0.0").describe("Bump for new content."),
        sourceCode: z.string().min(1).max(2000).describe("Inline JavaScript, max 2000 characters (Webflow limit)."),
        location: z.enum(["header", "footer"]).default("footer"),
        attributes: z.record(z.string(), z.string()).optional().describe("Extra <script> attributes, e.g. { async: 'true' }."),
        confirm: confirmArg,
        planId: planIdArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ client: alias, scope, page, displayName, version, sourceCode, location, attributes, confirm, planId }) => {
      const client = ctx.client(alias);
      const [{ target, label }, registered] = await Promise.all([resolveTarget(client, scope, page), listRegistered(client)]);
      const reused = registered.find((r) => r.displayName === displayName && r.version === version);
      const fullTarget: CustomCodeTarget = reused
        ? target
        : { ...target, pendingScript: { displayName, version, sourceCode } };

      const result = await guardedWrite({
        ctx,
        clientAlias: alias,
        op: customCodeOp,
        target: fullTarget,
        propose: (current) => upsertScript({ current, registered, displayName, version, location, attributes }).next,
        confirm,
        planId,
        summary: `Upsert script "${displayName}" v${version} on ${label}`,
      });
      const note = reused
        ? `Reusing registered script "${displayName}" v${version}; its existing source is used, not the sourceCode passed. Bump version to ship new code.`
        : undefined;
      return ok(note ? { ...result, note } : result);
    }),
  );

  server.registerTool(
    "code_remove",
    {
      title: "Remove an applied script",
      description:
        "Guarded removal of an applied script (matched by displayName) from the site or a page. The script stays " +
        "registered, so it can be re-applied or restored from the snapshot. First call is a dry run.",
      inputSchema: { client: clientArg, ...scopeArgs, displayName: z.string().min(1), confirm: confirmArg, planId: planIdArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ client: alias, scope, page, displayName, confirm, planId }) => {
      const client = ctx.client(alias);
      const [{ target, label }, registered] = await Promise.all([resolveTarget(client, scope, page), listRegistered(client)]);
      const ids = new Set(registered.filter((r) => r.displayName === displayName).map((r) => r.id));
      if (ids.size === 0) throw new Error(`No registered script named "${displayName}".`);
      const result = await guardedWrite({
        ctx,
        clientAlias: alias,
        op: customCodeOp,
        target,
        propose: (current) => current.filter((s) => !ids.has(s.id)),
        confirm,
        planId,
        summary: `Remove script "${displayName}" from ${label}`,
      });
      return ok(result);
    }),
  );
}
