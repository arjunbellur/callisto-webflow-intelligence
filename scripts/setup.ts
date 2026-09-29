#!/usr/bin/env tsx
/**
 * One-shot local setup for the Callisto MCP server.
 *
 *   npm run setup
 *
 * 1. Verifies Node and builds (npm run setup installs dependencies first).
 * 2. Reads WEBFLOW_API_TOKEN from .env or prompts for it (input hidden), verifies it, writes .env.
 * 3. Lists every site the token can reach and generates clients.json (existing entries are kept).
 * 4. Prints the Claude Desktop / Claude Code config snippet with the absolute path.
 *
 * Re-running is safe: it never overwrites a token or an existing client entry.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseRegistry, type Registry } from "../src/config.js";
import type { Site } from "../src/webflow/types.js";
import { done, ensureToken, fail, log, readEnvToken, root, TOKEN_VAR } from "./lib.js";

const clientsFile = path.join(root, "clients.json");


function run(cmd: string): void {
  log(cmd);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

/** Derives a registry alias from a site's short name, ensuring uniqueness. */
function toAlias(site: Site, taken: Set<string>): string {
  const base =
    (site.shortName || site.displayName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "site";
  let alias = base;
  for (let i = 2; taken.has(alias); i++) alias = `${base}-${i}`;
  taken.add(alias);
  return alias;
}

function liveUrlOf(site: Site): string | undefined {
  const custom = site.customDomains?.find((d) => d.url.startsWith("www.")) ?? site.customDomains?.[0];
  if (custom) return `https://${custom.url.replace(/^https?:\/\//, "")}`;
  return site.shortName ? `https://${site.shortName}.webflow.io` : undefined;
}

async function main(): Promise<void> {
  const [major] = process.versions.node.split(".").map(Number);
  if (!major || major < 20) fail(`Node 20+ is required (found ${process.versions.node}).`);

  run("npm run build");

  // Token: env var > .env > prompt. Re-prompts until a token passes verification.
  const { sites } = await ensureToken(process.env[TOKEN_VAR] || readEnvToken());
  done(`Found ${sites.length} site(s).`);

  // Merge into clients.json without touching existing entries.
  const existing: Registry = existsSync(clientsFile)
    ? parseRegistry(JSON.parse(readFileSync(clientsFile, "utf8")), clientsFile)
    : { clients: [] };
  const knownSiteIds = new Set(existing.clients.map((c) => c.siteId));
  const takenAliases = new Set(existing.clients.map((c) => c.alias));

  const added = sites
    .filter((s) => !knownSiteIds.has(s.id))
    .map((s) => {
      const liveUrl = liveUrlOf(s);
      return { alias: toAlias(s, takenAliases), name: s.displayName, siteId: s.id, ...(liveUrl ? { liveUrl } : {}) };
    });
  const registry = { clients: [...existing.clients, ...added] };
  writeFileSync(clientsFile, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  done(`clients.json: ${existing.clients.length} kept, ${added.length} added.`);

  console.log("\n  alias".padEnd(24) + "name".padEnd(32) + "siteId");
  for (const c of registry.clients) console.log(`  ${c.alias.padEnd(22)}${c.name.slice(0, 30).padEnd(32)}${c.siteId}`);

  // Claude config.
  const snippet = {
    mcpServers: {
      callisto: { command: "node", args: [path.join(root, "dist", "index.js")], cwd: root },
    },
  };
  console.log("\nAdd this to your Claude config and restart Claude:");
  console.log("  Claude Desktop (macOS): ~/Library/Application Support/Claude/claude_desktop_config.json");
  console.log("  Claude Code:            claude mcp add-json callisto '" + JSON.stringify(snippet.mcpServers.callisto) + "'\n");
  console.log(JSON.stringify(snippet, null, 2));
  console.log("\nThen ask Claude: \"run clients_list\" to confirm the connection.");
  console.log("Tip: set \"readOnly\": true in clients.json for any site that must not be edited yet.");
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
