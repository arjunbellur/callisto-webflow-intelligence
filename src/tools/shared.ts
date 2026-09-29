import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ResolvedClient } from "../context.js";
import { GuardError } from "../core/guard.js";
import { WebflowApiError } from "../webflow/errors.js";
import type { Page } from "../webflow/types.js";

export const OBJECT_ID = /^[0-9a-f]{24}$/;

export const clientArg = z.string().min(1).describe("Client alias from the Callisto registry (see clients_list).");
export const confirmArg = z
  .boolean()
  .default(false)
  .describe("false (default) = dry run that returns a diff and planId. true = apply the plan identified by planId.");
export const planIdArg = z.string().optional().describe("planId returned by the dry run. Required when confirm is true.");
export const pageArg = z
  .string()
  .min(1)
  .describe("Page id (24-char hex), slug (e.g. 'about') or published path (e.g. '/company/about').");

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorMessage(err: unknown): string {
  if (err instanceof WebflowApiError) {
    const hint =
      err.status === 401 || err.status === 403
        ? " Check that the client's token is valid and has the required scopes (sites, pages, cms, custom_code)."
        : err.status === 429
          ? " Rate limited by Webflow; wait a minute before retrying."
          : "";
    return `${err.message}${hint}`;
  }
  if (err instanceof GuardError) return `Guard: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Wraps a tool handler so failures come back as tool errors the agent can read and act on. */
export function safe<A>(handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      console.error("[callisto-mcp] tool error:", err);
      return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
    }
  };
}

export async function listPages(client: ResolvedClient): Promise<Page[]> {
  return client.api.paginate<Page>(`sites/${client.config.siteId}/pages`, "pages");
}

/** Resolves a page reference (id, slug or published path) to exactly one page of the client's site. */
export async function resolvePage(client: ResolvedClient, ref: string): Promise<Page> {
  const trimmed = ref.trim();
  if (OBJECT_ID.test(trimmed)) return client.api.get<Page>(`pages/${trimmed}`);

  const pages = await listPages(client);
  const normalized = trimmed.replace(/^\/+|\/+$/g, "");
  const matches = pages.filter(
    (p) => p.publishedPath?.replace(/^\/+|\/+$/g, "") === normalized || (p.slug === normalized && !p.collectionId),
  );
  // Prefer an exact published-path match when slugs collide across folders.
  const exact = matches.filter((p) => p.publishedPath?.replace(/^\/+|\/+$/g, "") === normalized);
  const pool = exact.length ? exact : matches;
  if (pool.length === 1) return pool[0]!;
  if (pool.length === 0) throw new Error(`No page matches "${ref}" on ${client.config.alias}. Use pages_list to find it.`);
  const options = pool.map((p) => `${p.id} (${p.publishedPath ?? p.slug})`).join(", ");
  throw new Error(`"${ref}" is ambiguous on ${client.config.alias}: ${options}. Pass the page id instead.`);
}
