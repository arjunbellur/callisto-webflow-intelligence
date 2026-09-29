import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./context.js";
import { registerAuditTools } from "./tools/audit.js";
import { registerClientTools } from "./tools/clients.js";
import { registerCmsTools } from "./tools/cms.js";
import { registerCodeTools } from "./tools/code.js";
import { registerPageTools } from "./tools/pages.js";
import { registerPublishTools } from "./tools/publish.js";

export const SERVER_NAME = "callisto";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Callisto is the agency's guarded operations layer for customer Webflow sites.
- Resolve customers with clients_list; always act on one client alias at a time.
- Every write is two-phase: call without confirm to get a diff + planId, show the diff to the user, then call with confirm: true and the planId.
- Writes are staged. Nothing is live until site_publish (also two-phase). After publishing, run verify_live.
- For element, style, component and layout edits use the official Webflow MCP with the client's siteId. Take page_content_snapshot first, and call change_record after each successful edit so the audit trail is complete.
- Roll back with snapshot_restore using the snapshotId returned by an applied change.`;

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerClientTools(server, ctx);
  registerPageTools(server, ctx);
  registerCmsTools(server, ctx);
  registerCodeTools(server, ctx);
  registerPublishTools(server, ctx);
  registerAuditTools(server, ctx);
  return server;
}
