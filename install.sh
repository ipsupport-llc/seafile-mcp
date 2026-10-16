#!/bin/bash
# Registers seafile-mcp in Claude Desktop's config. Safe to re-run.
# For any other MCP client: ./install.sh --print shows the config block to paste.
# Options (the same settings as the .mcpb extension). Settings from an earlier install are kept
# unless an option changes them:
#   --read-only / --no-read-only   hide / show the write tool
#   --server URL                   Seafile server, e.g. https://cloud.example.com ("" clears it)
#   --local-dir DIR                the only local folder for downloads and uploads, default ~/Downloads
#   --reset                        forget all earlier settings
#   --print                        only print the config block for another MCP client
set -euo pipefail

READ_ONLY="-"; URL_ARG="-"; LOCAL_ARG="-"; RESET=""; PRINT=""   # "-" = keep what is there
while [ $# -gt 0 ]; do
  case "$1" in
    --read-only) READ_ONLY="true"; shift ;;
    --no-read-only) READ_ONLY=""; shift ;;
    --server) [ $# -ge 2 ] || { echo "--server needs an address"; exit 1; }; URL_ARG="$2"; shift 2 ;;
    --local-dir) [ $# -ge 2 ] || { echo "--local-dir needs a folder"; exit 1; }; LOCAL_ARG="$2"; shift 2 ;;
    --reset) RESET="1"; shift ;;
    --print) PRINT="1"; shift ;;
    -h|--help) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$DIR/server/seafile-mcp.js"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
[ -f "$SERVER" ] || { echo "server/seafile-mcp.js not found"; exit 1; }

if [ -n "$PRINT" ]; then # config block for any MCP client; nothing is written
  SERVER="$SERVER" READ_ONLY="$READ_ONLY" URL_ARG="$URL_ARG" LOCAL_ARG="$LOCAL_ARG" /usr/bin/osascript -l JavaScript - <<'JS'
ObjC.import('Foundation');
function env(k) { var v = $.NSProcessInfo.processInfo.environment.objectForKey(k); return v.isNil() ? '' : ObjC.unwrap(v); }
var e = {};
if (env('READ_ONLY') && env('READ_ONLY') !== '-') e.SEAFILE_READ_ONLY = 'true';
if (env('URL_ARG') && env('URL_ARG') !== '-') e.SEAFILE_URL = env('URL_ARG');
if (env('LOCAL_ARG') && env('LOCAL_ARG') !== '-') e.SEAFILE_LOCAL_DIR = env('LOCAL_ARG');
var server = { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', env('SERVER')] };
if (Object.keys(e).length) server.env = e;
JSON.stringify({ mcpServers: { 'seafile': server } }, null, 2);
JS
  exit 0
fi
mkdir -p "$(dirname "$CFG")"

BAK=""
if [ -s "$CFG" ]; then BAK="$CFG.bak.$(date +%Y%m%d%H%M%S)"; cp "$CFG" "$BAK"; fi

# The config is edited as JSON by JavaScript for Automation (built into macOS); values come in through env.
SETTINGS=$(CFG="$CFG" SERVER="$SERVER" READ_ONLY="$READ_ONLY" URL_ARG="$URL_ARG" LOCAL_ARG="$LOCAL_ARG" RESET="$RESET" /usr/bin/osascript -l JavaScript - <<'JS'
ObjC.import('Foundation');
function env(k) { var v = $.NSProcessInfo.processInfo.environment.objectForKey(k); return v.isNil() ? '' : ObjC.unwrap(v); }
var path = env('CFG'), text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null), cfg = {};
if (!text.isNil() && ObjC.unwrap(text).trim()) {
  try { cfg = JSON.parse(ObjC.unwrap(text)); } catch (e) { throw new Error('Claude config is not valid JSON: ' + path + ' — fix it or restore a .bak copy, then run again.'); }
}
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
if (!isObject(cfg) || (cfg.mcpServers !== undefined && !isObject(cfg.mcpServers))) throw new Error('Claude config has an unexpected shape (mcpServers is not an object): ' + path);
cfg.mcpServers = cfg.mcpServers || {};
var old = cfg.mcpServers['seafile'], settings = {};
if (!env('RESET') && old && isObject(old.env)) for (var k in old.env) settings[k] = old.env[k];
function setting(name, value) { if (value === '-') return; if (value) settings[name] = value; else delete settings[name]; }
setting('SEAFILE_READ_ONLY', env('READ_ONLY'));
setting('SEAFILE_URL', env('URL_ARG'));
setting('SEAFILE_LOCAL_DIR', env('LOCAL_ARG'));
cfg.mcpServers['seafile'] = { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', env('SERVER')], env: settings };
if (!$(JSON.stringify(cfg, null, 2) + '\n').writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)) throw new Error('Could not write ' + path);
Object.keys(settings).length ? 'Settings:  ' + JSON.stringify(settings) : '';
JS
)

echo "Installed: $SERVER"
if [ -n "$SETTINGS" ]; then echo "$SETTINGS"; fi
if [ -n "$BAK" ]; then echo "Backup:    $BAK"; fi
echo "Now quit Claude (Cmd+Q) and open it again."
