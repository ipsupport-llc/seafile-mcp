#!/bin/bash
# Removes seafile-mcp from Claude Desktop's config.
set -euo pipefail

CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
[ -s "$CFG" ] || { echo "No Claude config found."; exit 0; }

BAK="$CFG.bak.$(date +%Y%m%d%H%M%S)"
cp "$CFG" "$BAK"
RESULT=$(CFG="$CFG" /usr/bin/osascript -l JavaScript - <<'JS'
ObjC.import('Foundation');
var path = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('CFG'));
var cfg = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null)));
var had = !!(cfg.mcpServers && cfg.mcpServers['seafile']);
if (had) {
  delete cfg.mcpServers['seafile'];
  if (!$(JSON.stringify(cfg, null, 2) + '\n').writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)) throw new Error('Could not write ' + path);
}
had ? 'removed' : 'absent';
JS
)
if [ "$RESULT" = "removed" ]; then
  echo "Removed seafile from Claude config. Backup: $BAK"
  echo "Quit Claude (Cmd+Q) and open it again."
else
  rm -f "$BAK"
  echo "seafile was not configured."
fi
