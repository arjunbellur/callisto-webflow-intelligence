import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { hash } from "../core/diff.js";
import { GuardError } from "../core/guard.js";
import { checkLivePage } from "../core/verify.js";
import type { Site } from "../webflow/types.js";
import { clientArg, confirmArg, ok, planIdArg, safe } from "./shared.js";

export function registerPublishTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "site_publish",
    {
      title: "Publish a client site",
      description:
        "Guarded publish of a client's site (pushes ALL staged changes live, including edits made in the Designer or via " +
        "the official Webflow MCP). The dry run lists target domains and the Callisto-recorded changes since the last " +
        "publish; call again with confirm: true and the planId to publish. Webflow allows about one publish per minute.",
      inputSchema: {
        client: clientArg,
        domains: z
          .array(z.string())
          .optional()
          .describe("Custom domain URLs to publish to (e.g. 'www.acme.com'). Defaults to all custom domains."),
        includeWebflowSubdomain: z.boolean().default(true),
        confirm: confirmArg,
        planId: planIdArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ client: alias, domains, includeWebflowSubdomain, confirm, planId }) => {
      const client = ctx.client(alias);
      const siteId = client.config.siteId;
      const site = await client.api.get<Site>(`sites/${siteId}`);
      const available = site.customDomains ?? [];
      const normalize = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();

      const selected = domains
        ? domains.map((d) => {
            const match = available.find((a) => normalize(a.url) === normalize(d));
            if (!match) throw new Error(`Domain "${d}" is not attached to this site. Available: ${available.map((a) => a.url).join(", ")}`);
            return match;
          })
        : available;
      if (selected.length === 0 && !includeWebflowSubdomain) throw new Error("Nothing to publish to: no domains selected.");

      const pending = (await ctx.audit.changesSince(client.config.alias, site.lastPublished)).map((e) => ({ ts: e.ts, kind: e.kind, source: e.source, summary: e.summary }));

      const plan = {
        siteId,
        domainIds: selected.map((d) => d.id).sort(),
        includeWebflowSubdomain,
        lastPublished: site.lastPublished ?? null,
      };
      const expectedPlanId = hash({ kind: "site.publish", ...plan });
      const summary = {
        site: site.displayName,
        lastPublished: site.lastPublished ?? null,
        domains: selected.map((d) => d.url),
        webflowSubdomain: includeWebflowSubdomain,
        recordedChangesSinceLastPublish: pending,
      };

      if (!confirm) {
        return ok({
          status: "planned",
          planId: expectedPlanId,
          ...summary,
          message:
            "Dry run only. Publishing also ships any unrecorded Designer edits. Call again with confirm: true and this planId.",
        });
      }
      if (client.config.readOnly) throw new GuardError(`Client "${client.config.alias}" is readOnly; refusing to publish.`);
      if (planId !== expectedPlanId) {
        throw new GuardError("planId does not match (arguments changed or the site was published since). Re-run the dry run.");
      }

      try {
        const result = await client.api.post(`sites/${siteId}/publish`, {
          customDomains: plan.domainIds,
          publishToWebflowSubdomain: includeWebflowSubdomain,
        });
        await ctx.audit.append({
          client: client.config.alias,
          kind: "site.publish",
          status: "applied",
          source: "callisto",
          target: plan,
          planId,
          summary: `Published to ${[...summary.domains, ...(includeWebflowSubdomain ? ["webflow.io"] : [])].join(", ")}`,
        });
        return ok({
          status: "published",
          ...summary,
          result,
          message: "Publish requested. Use verify_live to confirm the changes are live (CDN propagation can take a minute).",
        });
      } catch (err) {
        await ctx.audit.append({
          client: client.config.alias,
          kind: "site.publish",
          status: "failed",
          source: "callisto",
          target: plan,
          planId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }),
  );

  server.registerTool(
    "verify_live",
    {
      title: "Verify a live page",
      description:
        "Fetch a published page (bypassing cache) and check that expected text is present and unwanted text is absent. " +
        "Also reports status, <title>, meta description and og:title. Use after site_publish.",
      inputSchema: {
        client: clientArg,
        path: z.string().default("/").describe("Path on the client's liveUrl, or a full https:// URL."),
        expect: z.array(z.string()).default([]).describe("Strings that must appear in the page HTML or text."),
        absent: z.array(z.string()).default([]).describe("Strings that must NOT appear."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ client: alias, path, expect, absent }) => {
      const client = ctx.client(alias);
      let url: URL;
      if (/^https?:\/\//i.test(path)) url = new URL(path);
      else if (client.config.liveUrl) url = new URL(path, client.config.liveUrl);
      else throw new Error(`Client "${client.config.alias}" has no liveUrl in the registry; pass a full URL.`);
      return ok(await checkLivePage(url, expect, absent));
    }),
  );
}
