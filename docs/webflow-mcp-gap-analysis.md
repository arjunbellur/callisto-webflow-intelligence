# Webflow MCP gap analysis

Source: the official Webflow MCP server, version 2.1.0, inspected on 2026-09-29 via `webflow_guide_tool`.

## What the official server covers

Data tools (REST, work headless):

- Sites: list, get, publish (optionally single page on Enterprise).
- Pages: list, metadata, settings update, create, schema markup, sitemap flags, Enterprise page branching.
- Elements and settings (`data_element_tool`, `data_element_settings_tool`): query, tree, move, remove, attributes, styles, links, text, images, heading level, tag, visibility, DOM id, display name, prop bindings.
- Builders: `data_element_builder`, `data_component_builder`, `data_whtml_builder` (insert from HTML/CSS).
- Components, variants and props: full lifecycle.
- Styles and variables: create, update, query.
- CMS: collections, fields, field groups, items (CRUD, publish, unpublish, localization, filters and sort).
- Assets, folders, compression, fonts, forms and submissions, comments, freeform custom code, registered scripts, interactions, localization, webhooks, analytics reports, campaigns, Webflow Cloud apps.
- Site-specific agent instructions (`data_agent_instructions_tool`).

Designer tools (require the Designer open in a browser with the MCP app): select element, snapshot to PNG, open canvases, switch pages, folder creation, current mode.

## Gaps for an agency automation

| Gap | Impact | Callisto answer |
| --- | --- | --- |
| No customer registry; site ids must be supplied every time | Wrong-site risk, friction | `clients.json` registry, alias resolution, per-client token and read-only flag |
| Writes are immediate; the only protection is the guide telling the agent to "confirm with the user" for destructive actions | A mis-phrased instruction can change a production site | Two-phase dry run + confirm with a live-state hash (`planId`) |
| No undo | Recovery means manual Designer work or a Webflow backup restore | Snapshots and `snapshot_restore` for page settings, CMS fields and applied scripts; DOM snapshots for reference |
| No audit trail | Cannot answer "what changed for client X this month" | Append-only JSONL log; `change_record` for edits made through Webflow's tools |
| Publish is a single call with no summary | Ships everything staged, including forgotten Designer edits | Publish dry run lists recorded changes since last publish and target domains |
| No post-publish verification | Silent CDN/cache issues | `verify_live` |
| Page/CMS lookups need ids | Extra round trips | Lookup by slug, path or collection name |
| Rate limits (60 req/min per token, ~1 publish/min) | Bulk work fails midway | Retry with backoff; bulk recipes planned |

## Explicitly not duplicated

Element, style, component, variable, asset and interaction editing stay on the official server. Re-implementing them would be large, would lag Webflow's own updates, and gains nothing: the Callisto server wraps those edits with `page_content_snapshot` before and `change_record` after, which is where the value is.

## Constraints that shape the design

- The Data API has no transactional or "preview" mode. Safety therefore comes from reading live state, diffing, and re-validating before write.
- Custom code: inline registered scripts are capped at 2000 characters and are immutable per version; the upsert tool bumps versions instead of editing.
- Slug changes alter URLs; Webflow redirects are managed under site settings (API: `sites/{id}/redirects`), a candidate for a follow-up tool.
- Designer tools cannot run headless. Anything that needs a visual check still needs a Designer session or a `verify_live` fetch of the published page.
