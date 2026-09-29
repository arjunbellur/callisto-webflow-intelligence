#!/bin/bash
# Prepares a Claude Code on the web session: installs dependencies and builds the Callisto MCP
# server so .mcp.json can start it. Skipped on local machines.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
npm install --no-audit --no-fund
npm run build

if [ -z "${WEBFLOW_API_TOKEN:-}" ]; then
  echo "callisto: WEBFLOW_API_TOKEN is not set; add it as an environment credential for the MCP server to reach Webflow." >&2
fi
