# Callisto Webflow MCP

A local MCP server that lets Claude perform custom edits on Callisto's customer Webflow sites without opening the Webflow app, safely.

It is a **thin guarded layer** that runs next to the [official Webflow MCP](https://developers.webflow.com/data/docs/ai-tools), not a replacement for it. Webflow's server already covers raw edits well (elements, styles, components, CMS, pages, assets, custom code, publishing). What it does not provide is what an agency needs when an agent touches production sites for many customers:

| Need | Official Webflow MCP | Callisto MCP |
| --- | --- | --- |
| "Update the pricing page for Acme" without knowing site ids | No registry; site id must be supplied | `clients_list` maps an alias to a site id, token and live URL |
| Preview a change before it happens | Writes immediately | Every write is two-phase: dry run with a diff, then confirm with a `planId` |
| Protect against stale plans and concurrent Designer edits | None | `planId` is a hash of the live state; it is rejected if anything changed |
| Undo | None | Pre-change snapshots and `snapshot_restore` |
| Who changed what, when, for which customer | None | Append-only audit log, including edits made through the Webflow MCP via `change_record` |
| Know what a publish will ship | None | `site_publish` dry run lists recorded changes since the last publish |
| Confirm the change is actually live | None | `verify_live` fetches the page and checks expected/absent text |
| Read-only customers, per-customer tokens | None | Registry flags |

## Setup

```bash
git clone https://github.com/arjunbellur/callisto-webflow-intelligence.git
cd callisto-webflow-intelligence
npm run setup
```

`npm run setup` installs and builds, asks for a Webflow token (Workspace settings > Apps & integrations > API access; scopes: sites, pages, cms, custom_code) and stores it in `.env`, then lists every site the token can reach and writes them to `clients.json` with generated aliases. Re-running keeps existing tokens and entries. It ends by printing the Claude config snippet.

To replace the token later, run `npm run token`: it verifies the new token against Webflow and only saves it when it works.

Manual alternative: `cp clients.example.json clients.json`, `cp .env.example .env`, fill both in, `npm run build`.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "callisto": {
      "command": "node",
      "args": ["/absolute/path/to/callisto-webflow-intelligence/dist/index.js"],
      "cwd": "/absolute/path/to/callisto-webflow-intelligence"
    }
  }
}
```

The server reads `clients.json` and `.env` from its working directory. Run `npm run inspect` to try the tools in the MCP Inspector.

## Tools

| Tool | Purpose | Write |
| --- | --- | --- |
| `clients_list` | Registry: alias, siteId, liveUrl, readOnly | no |
| `client_overview` | Domains, locales, last publish, page/collection counts, unpublished changes | no |
| `pages_list` | Pages with SEO fields; filter by text | no |
| `page_meta_update` | Title, slug, SEO title/description, Open Graph | guarded |
| `page_content_snapshot` | Save the page DOM (text, images, props) as a snapshot; returns text nodes | snapshot only |
| `cms_collections_list` | Collections, optionally with field schema | no |
| `cms_items_find` | Search items by name/slug | no |
| `cms_item_update` | Field-level item update, validated against the schema | guarded |
| `code_list` | Registered scripts and where they are applied | no |
| `code_upsert` | Add or replace an inline script (analytics, pixels) on the site or a page | guarded |
| `code_remove` | Remove an applied script | guarded |
| `site_publish` | Publish to selected domains | guarded |
| `verify_live` | Fetch a live URL and assert expected/absent text plus meta tags | no |
| `snapshot_restore` | Roll back a guarded change | guarded |
| `audit_query` | Read the change log | no |
| `change_record` | Log an edit made with another tool | log only |

"Guarded" means the two-phase protocol:

1. Call the tool. It reads live state, computes the change and returns `{ status: "planned", planId, changes }`. Nothing is written.
2. Call again with `confirm: true` and that `planId`. The server re-reads live state; if the arguments or the site changed since step 1, the plan is rejected. Otherwise it saves a snapshot, writes, and appends to the audit log.

All content writes are staged in Webflow. Nothing reaches the live site until `site_publish`.

## Recommended workflow with Claude

```
1. clients_list                          -> pick the alias
2. page_content_snapshot (for layout work) or pages_list / cms_items_find
3. Edit:
   - copy, SEO, CMS, scripts       -> Callisto guarded tools (dry run, review, confirm)
   - elements, styles, components  -> official Webflow MCP with the client's siteId,
                                      then change_record so the audit trail is complete
4. site_publish (dry run shows everything that will ship, then confirm)
5. verify_live with the strings you expect on the page
```

The server's MCP instructions tell Claude to follow this order automatically.

## Design notes

- `src/webflow/client.ts`: typed Data API v2 client. 429 is always retried with Retry-After; 5xx and network errors are retried only for idempotent methods.
- `src/core/guard.ts`: the two-phase write protocol, generic over an `Operation` (read state, write state). Every operation is reversible because rollback is just "write the snapshot's `before` through the same operation".
- `src/operations/*`: page settings, CMS item fields and applied custom code as reversible operations. Adding a new guarded tool means adding one operation and one tool registration.
- `src/core/audit.ts`, `src/core/snapshots.ts`: JSONL log and JSON snapshots under `.callisto/` (gitignored). Point `CALLISTO_DATA_DIR` at a shared drive if several people run the server.
- Tokens never leave the environment; the registry stores only the name of the variable.

## Roadmap

- Bulk recipes: apply one guarded change across many clients with a single review (e.g. roll out a new analytics script).
- Element text edits via the DOM API, guarded and reversible, so simple copy changes don't need the Designer session.
- Redirect management when slugs change.
- Hosted (HTTP) transport with per-user auth for team-wide and scheduled automation.

## Development

```bash
npm run typecheck
npm test
npm run dev        # run from source with tsx
```
