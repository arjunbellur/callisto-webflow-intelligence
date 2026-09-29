#!/usr/bin/env tsx
/**
 * One-shot local setup for the Callisto MCP server.
 *
 *   npm run setup
 *
 * 1. Verifies Node, installs dependencies and builds.
 * 2. Reads WEBFLOW_API_TOKEN from .env or prompts for it (input hidden) and writes .env.
 * 3. Lists every site the token can reach and generates clients.json (existing entries are kept).
 * 4. Prints the Claude Desktop / Claude Code config snippet with the absolute path.
 *
 * Re-running is safe: it never overwrites a token or an existing client entry.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseRegistry, type Registry } from "../src/config.js";
import { WebflowClient } from "../src/webflow/client.js";
import { WebflowApiError } from "../src/webflow/errors.js";
import type { Site } from "../src/webflow/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
const clientsFile = path.join(root, "clients.json");
const TOKEN_VAR = "WEBFLOW_API_TOKEN";

const log = (msg: string) => console.log(`\x1b[36m›\x1b[0m ${msg}`);
const done = (msg: string) => console.log(`\x1b[32m✔\x1b[0m ${msg}`);
const fail = (msg: string): never => {
  console.error(`\x1b[31m✖\x1b[0m ${msg}`);
  process.exit(1);
};

function run(cmd: string): void {
  log(cmd);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

/** Prompts on the terminal; hides typed characters when `secret` is true. */
function prompt(question: string, secret = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = output._writeToOutput;
    if (secret) output._writeToOutput = (s) => (s.includes(question) ? original.call(rl, question) : undefined);
    rl.question(question, (answer) => {
      rl.close();
      if (secret) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function readEnvToken(): string | undefined {
  if (!existsSync(envFile)) return undefined;
  const line = readFileSync(envFile, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${TOKEN_VAR}=`));
  const value = line?.slice(TOKEN_VAR.length + 1).trim().replace(/^["']|["']$/g, "");
  return value || undefined;
}

function writeEnvToken(token: string): void {
  const template = existsSync(envFile)
    ? readFileSync(envFile, "utf8")
    : readFileSync(path.join(root, ".env.example"), "utf8");
  const lines = template.split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`${TOKEN_VAR}=`));
  const entry = `${TOKEN_VAR}=${token}`;
  if (idx >= 0) lines[idx] = entry;
  else lines.unshift(entry);
  writeFileSync(envFile, lines.join("\n"), "utf8");
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

  if (!existsSync(path.join(root, "node_modules", "@modelcontextprotocol"))) run("npm install");
  run("npm run build");

  // Token: env var > .env > prompt.
  let token = process.env[TOKEN_VAR] || readEnvToken();
  if (!token) {
    console.log("\nCreate a token in Webflow: Workspace settings › Apps & integrations › API access.");
    console.log("Scopes: sites, pages, cms, custom_code (read and write).");
    token = await prompt(`Paste your ${TOKEN_VAR}: `, true);
    if (!token) fail("No token provided.");
    writeEnvToken(token);
    done(`Saved token to ${path.relative(process.cwd(), envFile)} (gitignored).`);
  } else {
    done("Using existing token.");
  }

  // Discover sites.
  const api = new WebflowClient({ token });
  let sites: Site[];
  try {
    sites = (await api.get<{ sites: Site[] }>("sites")).sites ?? [];
  } catch (err) {
    if (err instanceof WebflowApiError && (err.status === 401 || err.status === 403)) {
      return fail(`Webflow rejected the token (${err.status}). Check it is a workspace token with the sites scope.`);
    }
    throw err;
  }
  if (sites.length === 0) fail("The token can reach no sites. Authorize it for at least one site and re-run.");
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
