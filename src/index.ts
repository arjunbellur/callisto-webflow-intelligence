#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { createServer, SERVER_VERSION } from "./server.js";

// stdout carries the MCP protocol; all diagnostics go to stderr.
async function main(): Promise<void> {
  const config = loadConfig();
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
