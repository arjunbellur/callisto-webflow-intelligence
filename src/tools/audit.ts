import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { guardedWrite } from "../core/guard.js";
import { restorableOps } from "../operations/index.js";
import { clientArg, confirmArg, ok, planIdArg, safe } from "./shared.js";

export function registerAuditTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "audit_query",
    {
      title: "Query the change log",
      description: "Read Callisto's audit trail of applied, failed and externally recorded changes, newest first.",
      inputSchema: {
        client: clientArg.optional(),
        kind: z.string().optional().describe("e.g. page.meta, cms.item, custom-code, site.publish, external"),
        since: z.iso.datetime({ offset: true }).optional(),
        limit: z.number().int().min(1).max(500).default(50),
        includeChanges: z.boolean().default(false).describe("Include field-level before/after diffs."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ client, kind, since, limit, includeChanges }) => {
      const alias = client ? ctx.client(client).config.alias : undefined;
      const entries = await ctx.audit.query({ client: alias, kind, since, limit });
      return ok(includeChanges ? entries : entries.map(({ changes, ...rest }) => ({ ...rest, changeCount: changes?.length ?? 0 })));
    }),
  );

  server.registerTool(
    "change_record",
    {
      title: "Record an external change",
      description:
        "Log a change made outside Callisto (e.g. element, style or component edits through the official Webflow MCP) " +
        "so the audit trail and publish summary stay complete. Call once per logical edit, right after it succeeds.",
      inputSchema: {
        client: clientArg,
        summary: z.string().min(3).describe("What changed, in one sentence, e.g. 'Hero H1 on /pricing: X -> Y'."),
        tool: z.string().default("webflow-mcp").describe("Where the change was made."),
        target: z.record(z.string(), z.unknown()).optional().describe("Ids involved, e.g. { pageId, elementId }."),
        before: z.unknown().optional(),
        after: z.unknown().optional(),
        snapshotId: z.string().optional().describe("page_content_snapshot id taken before the edit, if any."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ client, summary, tool, target, before, after, snapshotId }) => {
      const alias = ctx.client(client).config.alias;
      const entry = await ctx.audit.append({
        client: alias,
        kind: "external",
        status: "recorded",
        source: tool,
        summary,
        target,
        snapshotId,
        changes: before !== undefined || after !== undefined ? [{ path: "(external)", before, after }] : undefined,
      });
      return ok({ recorded: true, ts: entry.ts });
    }),
  );

  server.registerTool(
    "snapshot_restore",
    {
      title: "Roll back a change",
      description:
        "Restore the pre-change state captured in a snapshot (from page_meta_update, cms_item_update, code_upsert or " +
        "code_remove). Uses the same dry-run/confirm protocol; the rollback is staged until site_publish.",
      inputSchema: {
        snapshotId: z.string().min(1),
        confirm: confirmArg,
        planId: planIdArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ snapshotId, confirm, planId }) => {
      const snapshot = await ctx.snapshots.load(snapshotId);
      const op = restorableOps.get(snapshot.kind);
      if (!op) {
        throw new Error(`Snapshots of kind "${snapshot.kind}" are reference-only and cannot be restored automatically.`);
      }
      const result = await guardedWrite({
        ctx,
        clientAlias: snapshot.client,
        op,
        target: snapshot.target,
        propose: () => snapshot.before,
        confirm,
        planId,
        summary: `Restore snapshot ${snapshot.id}`,
      });
      return ok(result);
    }),
  );
}
