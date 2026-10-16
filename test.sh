#!/bin/bash
# Talks to the server directly (no MCP client): signs in if needed (opens the browser) and lists your libraries.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read","arguments":{"action":"status"}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read","arguments":{"action":"list_libraries"}}}' \
| /usr/bin/osascript -l JavaScript "$DIR/server/seafile-mcp.js"
