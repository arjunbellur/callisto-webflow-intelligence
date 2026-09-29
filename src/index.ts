#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { createServer, SERVER_VERSION } from "./server.js";

// stdout carries the MCP protocol; all diagnostics go to stderr.
async function main(): Promise<void> {
  // Resolve clients.json and .env from the current directory when they exist there, otherwise from
  // the repo root, so MCP hosts that launch the server from elsewhere need only the command path.
  const cwd = process.cwd();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const clientsFile = process.env.CALLISTO_CLIENTS_FILE ?? "clients.json";
  const config = loadConfig(process.env, existsSync(path.resolve(cwd, clientsFile)) ? cwd : repoRoot);
  const server = createServer(new AppContext(config));
  await server.connect(new StdioServerTransport());
  console.error(
    `[callisto-mcp] v${SERVER_VERSION} ready: ${config.registry.clients.length} client(s), data dir ${config.dataDir}`,
  );

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[callisto-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
