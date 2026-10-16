// Seafile MCP server — zero dependencies, runs on macOS built-in JXA (curl for HTTPS, the Keychain for the sign-in).
// Run:  /usr/bin/osascript -l JavaScript server/seafile-mcp.js
// Protocol: MCP over stdio (newline-delimited JSON-RPC 2.0). Logs go to stderr.
//
// Layout: config & IO → helpers → argument normalisation → system tools → server & sign-in → libraries & paths →
// ACTIONS (the one registry of what the `read` and `write` tools do) → dispatch → JSON-RPC & stdio.
//
// Callers are often small local models, so arguments are normalised before use (aliases, "true" strings,
// comma lists) and every mistake comes back as an error that says how to fix it.
// Anything that uploads, deletes, moves or shares is never guessed: unclear input there is an error, not a guess.

ObjC.import('Foundation');

var VERSION = '0.1.0'; // release.yml rewrites this from the tag

// ---------- IO ----------
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
function send(obj) {
  var s = JSON.stringify(obj) + '\n';
  stdout.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding));
}
function log(s) { console.log('[seafile-mcp] ' + s); } // stderr

// ---------- config (env from the MCP client; the .mcpb maps its extension settings to these) ----------
function env(k) {
  var v = '';
  try { v = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey(k)) || ''; } catch (e) {}
  v = String(v);
  return /^\$\{user_config\.[^}]*\}$/.test(v) ? '' : v; // an unset extension setting arrives as "${user_config.x}"
}
// ~, ${HOME} and $HOME expanded (some clients store them literally), then normalised
function stdPath(p) {
  var home = ObjC.unwrap($.NSHomeDirectory());
  p = String(p).replace(/^\$\{HOME\}|^\$HOME(?=\/|$)/, home);
  return ObjC.unwrap($(p).stringByExpandingTildeInPath.stringByStandardizingPath.stringByResolvingSymlinksInPath);
}
var READ_ONLY = /^(1|true|yes)$/i.test(env('SEAFILE_READ_ONLY'));
var LOCAL_DIR = stdPath(env('SEAFILE_LOCAL_DIR') || '~/Downloads'); // the only local folder files are saved to / uploaded from
var TMP_DIR = ObjC.unwrap($.NSTemporaryDirectory()).replace(/\/$/, '') + '/seafile-mcp';

// ---------- errors, notes, small helpers ----------
// UserError: a mistake in the call. `hint` tells the model what to do instead.
function UserError(message, hint) { this.message = message; this.hint = hint || ''; }
function fail(message, hint) { throw new UserError(message, hint); }
function errorText(e) { return e && e.message ? e.message : String(e); }

var NOTES = []; // remarks for the model on how its call was read; reset per call
function note(s) { if (NOTES.indexOf(s) < 0) NOTES.push(s); }

function iso(d) { try { return d ? new Date(d).toISOString() : null; } catch (e) { return null; } }
function lower(s) { return String(s == null ? '' : s).toLowerCase(); }
function trim(s) { return String(s).trim(); }
function safe(f, fallback) { try { return f(); } catch (e) { if (e instanceof Cancelled) throw e; return fallback; } }
function exists(ref) { return safe(function () { ref.name(); return true; }, false); }
function ext(base, more) { var o = {}, k; for (k in base) o[k] = base[k]; for (k in more) o[k] = more[k]; return o; }
function addrOf(s) { var m = /<([^>]+)>/.exec(s || ''); return trim(m ? m[1] : String(s || '')).toLowerCase(); }
function toList(v) { // "a, b; c" → [a, b, c]; separators inside quotes or <…> do not split
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(trim).filter(Boolean);
  var out = [], cur = '', quoted = false, angle = false, str = String(v);
  for (var i = 0; i < str.length; i++) {
    var ch = str[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '<') angle = true;
    else if (ch === '>') angle = false;
    if (!quoted && !angle && /[,;\n]/.test(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(trim).filter(Boolean);
}
function page(s, offset, max) { // long text in pages: {text, total_chars, next_offset?}
  s = String(s || '');
  var out = { text: s.slice(offset, offset + max), total_chars: s.length };
  if (offset + max < s.length) { out.next_offset = offset + max; note('Text is clipped; call again with offset ' + out.next_offset + ' for more.'); }
  return out;
}
function editDistance(a, b) {
  a = lower(a); b = lower(b);
  var prev = [], cur, i, j;
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++) {
    cur = [i];
    for (j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function closest(word, options) { // options within typo distance, best first
  var w = lower(word);
  return options.map(function (o) {
    var l = lower(o), d = editDistance(w, l);
    if (w.length >= 3 && (l.indexOf(w) >= 0 || w.indexOf(l) >= 0)) d = Math.min(d, 1);
    return { o: o, d: d };
  }).filter(function (x) { return x.d <= Math.max(2, Math.floor(w.length / 3)); })
    .sort(function (x, y) { return x.d - y.d; }).map(function (x) { return x.o; });
}
function didYouMean(word, options) { var c = closest(word, options); return c.length ? ' Did you mean "' + c[0] + '"?' : ''; }
function pickName(want, names) { // exact, then case-insensitive
  return names.filter(function (n) { return n === want; })[0] || names.filter(function (n) { return lower(n) === lower(want); })[0] || null;
}

// ---------- argument normalisation ----------
// Arg spec: { type, required, default, desc, values (enum), valueAliases, aliases, min, max, endOfDay, props, fromString }
// types: string, integer, boolean, id, ids, list (strings), addresses, date, object, objects
var KEY_ALIASES = { // alias → canonical; used only when the action has the canonical key and not the alias
  repo: 'library', repo_id: 'library', repository: 'library', lib: 'library', library_id: 'library', library_name: 'library', space: 'library',
  file: 'path', file_path: 'path', filepath: 'path', filename: 'path', folder: 'path', dir: 'path', directory: 'path', item: 'path', remote_path: 'path',
  files: 'paths', items: 'paths', names: 'paths', path_list: 'paths',
  destination: 'to_folder', target: 'to_folder', target_folder: 'to_folder', dest: 'to_folder', to: 'to_folder', into: 'to_folder', dst: 'to_folder', to_path: 'to_folder',
  target_library: 'to_library', dst_library: 'to_library', to_repo: 'to_library', dest_library: 'to_library',
  local_path: 'file', local_file: 'file', source: 'file', src: 'file', upload: 'file',
  save_to: 'to', local_folder: 'to', download_to: 'to',
  newname: 'new_name', name: 'new_name', rename_to: 'new_name', new: 'new_name',
  content: 'text', body: 'text', data: 'text', contents: 'text',
  q: 'query', search: 'query', keyword: 'query', term: 'query', pattern: 'query', name_contains: 'query',
  max: 'limit', count: 'limit', n: 'limit', max_results: 'limit', top: 'limit', page_size: 'limit',
  overwrite: 'replace', force: 'replace',
  test: 'dry_run', simulate: 'dry_run', dryrun: 'dry_run', preview: 'dry_run',
  version: 'commit_id', revision: 'commit_id', commit: 'commit_id',
  expires_in_days: 'expire_days', expiry_days: 'expire_days', days: 'expire_days', expire: 'expire_days',
  allow_download: 'can_download', allow_upload: 'can_upload', upload_allowed: 'can_upload',
  url: 'server', host: 'server', address: 'server', server_url: 'server',
  max_length: 'max_chars', length: 'max_chars', start_at: 'offset'
};
function snake(k) { return String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s\-.]+/g, '_').toLowerCase(); }

var TRUE_WORDS = /^(true|yes|y|1|on|да)$/i, FALSE_WORDS = /^(false|no|n|0|off|нет|none)$/i;
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds()); }
var ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
// ISO dates plus the words small models like to send. Returns a Date (with .dateOnly when no time was
// given) or null. strict (writes): only ISO 8601 and the words below, never the engine's loose parsing.
function parseWhen(v, endOfDay, strict) {
  if (v instanceof Date) return v;
  var s = lower(trim(v)), now = new Date(), m, day = null;
  if (s === 'now') return now;
  if (s === 'today') day = startOfDay(now);
  else if (s === 'tomorrow') day = startOfDay(addDays(now, 1));
  else if (s === 'yesterday') day = startOfDay(addDays(now, -1));
  else if ((m = /^([+-]\d+)\s*(d|days?)$/.exec(s))) day = startOfDay(addDays(now, parseInt(m[1], 10)));
  else if ((m = /^in\s+(\d+)\s*(d|days?|w|weeks?)$/.exec(s))) day = startOfDay(addDays(now, parseInt(m[1], 10) * (/^w/.test(m[2]) ? 7 : 1)));
  else if ((m = /^(\d+)\s*(d|days?|w|weeks?)\s+ago$/.exec(s))) day = startOfDay(addDays(now, -parseInt(m[1], 10) * (/^w/.test(m[2]) ? 7 : 1)));
  else if ((m = ISO_DATE.exec(trim(v)))) {
    var y = +m[1], mo = +m[2] - 1, d = +m[3], probe = new Date(y, mo, d);
    if (probe.getFullYear() !== y || probe.getMonth() !== mo || probe.getDate() !== d) return null; // 2026-02-30 is not a date
    if (m[4] == null) day = probe; // date only = that local day, not UTC midnight
    else {
      if (+m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59) return null;
      var t = new Date(trim(v).replace(' ', 'T'));
      if (isNaN(t.getTime())) return null;
      if (m[7] == null) t.localTime = true; // no offset: JavaScript reads it as this Mac's local time
      return t;
    }
  } else if (strict) return null;
  if (day) {
    var out = endOfDay ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59) : day;
    out.dateOnly = true;
    return out;
  }
  var loose = new Date(v);
  return isNaN(loose.getTime()) ? null : loose;
}

function coerce(v, spec, key, strict) {
  var t = spec.type;
  function bad(what) { fail('Argument "' + key + '" must be ' + what + ', got ' + JSON.stringify(v) + '.', spec.desc ? key + ': ' + spec.desc : ''); }
  if (Array.isArray(v) && v.length === 1 && ['string', 'integer', 'id', 'boolean', 'date', 'object'].indexOf(t) >= 0) v = v[0];
  switch (t) {
    case 'string': {
      if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
      if (typeof v !== 'string') bad('text');
      var s = spec.raw ? v : trim(v); // content (raw) is kept byte for byte; names and ids are trimmed
      if (!spec.values) return s;
      var hit = pickName(s, spec.values) || (spec.valueAliases || {})[lower(s)] || (spec.valueAliases || {})[snake(s)];
      if (!hit && !strict) { var c = closest(s, spec.values); if (c.length) { hit = c[0]; note('Read ' + key + ' "' + s + '" as "' + hit + '".'); } }
      if (!hit) fail('Argument "' + key + '" must be one of: ' + spec.values.join(', ') + '. Got "' + s + '".');
      return hit;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 1 || v === 0) return v === 1;
      if (typeof v === 'string' && TRUE_WORDS.test(trim(v))) return true;
      if (typeof v === 'string' && FALSE_WORDS.test(trim(v))) return false;
      return bad('true or false');
    case 'integer':
    case 'id': {
      var n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*#?-?\d+\s*$/.test(v) ? parseInt(String(v).replace('#', ''), 10) : NaN);
      if (!isFinite(n) || Math.floor(n) !== n) bad(t === 'id' ? 'a message id (a whole number from list_messages or search_messages)' : 'a whole number');
      var min = spec.min != null ? spec.min : (t === 'id' ? 1 : 0), tunable = spec['default'] !== undefined; // sizes and counts are adjusted, ids and indexes never
      if (n < min) { if (!tunable) bad('at least ' + min); note(key + ' raised to ' + min + '.'); n = min; }
      if (spec.max && n > spec.max) { if (!tunable) bad('at most ' + spec.max); note(key + ' capped at ' + spec.max + '.'); n = spec.max; }
      return n;
    }
    case 'ids': {
      var items = Array.isArray(v) ? v : (typeof v === 'string' ? toList(v) : [v]);
      if (!items.length) bad('a non-empty list of message ids');
      return items.map(function (x, i) { return coerce(x, { type: 'id' }, key + '[' + i + ']', strict); });
    }
    case 'list': {
      // a single string is one item: "/a,b.txt" is a file name, not two targets (pass an array for several)
      var names = (Array.isArray(v) ? v.map(String) : [String(v)]).map(trim).filter(Boolean);
      if (!names.length) bad('a non-empty list (leave it out instead)'); // an empty selector must not mean "all"
      return names;
    }
    case 'addresses': {
      var list = Array.isArray(v) ? v.map(String).map(trim).filter(Boolean) : toList(v);
      if (!list.length) bad('at least one email address');
      var wrong = list.filter(function (x) { return !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addrOf(x)); });
      if (wrong.length) fail('Not an email address: ' + wrong.join(', ') + ' (argument "' + key + '").', 'Give addresses like "anna@example.com" or "Anna <anna@example.com>", separated by commas.');
      return list;
    }
    case 'date': {
      var d = typeof v === 'string' || v instanceof Date ? parseWhen(v, spec.endOfDay, strict) : null;
      if (!d) bad('a real date: 2026-10-27, 2026-10-27T13:00:00-06:00, today, tomorrow, yesterday or "3 days ago"');
      return d;
    }
    case 'object':
    case 'objects':
      if (typeof v === 'string') {
        var parsed = safe(function () { return JSON.parse(v); }, undefined);
        if (parsed === undefined) { if (spec.fromString) return normaliseArgs(spec.fromString(v), spec.props, key, strict); bad(t === 'object' ? 'an object' : 'a list of objects'); }
        v = parsed;
      }
      if (t === 'object') return normaliseArgs(v, spec.props, key, strict);
      var objs = Array.isArray(v) ? v : [v];
      if (!objs.length) bad('a non-empty list');
      return objs.map(function (x, i) { return normaliseArgs(x, spec.props, key + '[' + i + ']', strict); });
  }
  return v;
}

// raw args → canonical args for one action. strict (write actions): unknown keys are errors, not ignored.
function normaliseArgs(raw, specs, path, strict) {
  if (raw == null) raw = {};
  if (typeof raw === 'string') raw = safe(function () { return JSON.parse(raw); }, raw);
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(path + ' must be an object like {"key": "value"}.');
  var out = {}, src = {}, unknown = [];
  Object.keys(raw).forEach(function (k) {
    var v = raw[k];
    if (v === null || v === undefined || (v === '' && !(specs[k] && specs[k].raw))) return;
    var key = specs[k] ? k : snake(k);
    if (!specs[key]) {
      var alias = Object.keys(specs).filter(function (c) { return (specs[c].aliases || []).indexOf(key) >= 0; })[0] || KEY_ALIASES[key];
      if (alias && specs[alias]) { note('Read "' + k + '" as "' + alias + '".'); key = alias; }
    }
    if (!specs[key]) { unknown.push(k); return; }
    var val = coerce(v, specs[key], key, strict);
    if (src[key] !== undefined && stableJSON(out[key]) !== stableJSON(val)) fail('"' + src[key] + '" and "' + k + '" both set ' + key + ', to different values. Give it once.');
    out[key] = val; src[key] = k;
  });
  if (unknown.length) {
    var allowed = Object.keys(specs);
    var msg = 'Unknown argument' + (unknown.length > 1 ? 's ' : ' ') + unknown.map(function (k) { return '"' + k + '"' + didYouMean(snake(k), allowed); }).join(', ');
    if (strict) fail(msg + '.', 'Allowed here: ' + (allowed.join(', ') || 'none') + '.');
    note(msg + ' — ignored. Allowed here: ' + (allowed.join(', ') || 'none') + '.');
  }
  var missing = Object.keys(specs).filter(function (k) { return specs[k].required && out[k] === undefined; })
    .map(function (k) { return path === 'args' ? k : path + '.' + k; });
  if (missing.length) fail('Missing required argument' + (missing.length > 1 ? 's: ' : ': ') + missing.join(', ') + '.',
    missing.map(function (k) { var spec = specs[k.split('.').pop()]; return k + ' — ' + (spec.desc || spec.type); }).join('; '));
  Object.keys(specs).forEach(function (k) { if (out[k] === undefined && specs[k]['default'] !== undefined) out[k] = specs[k]['default']; });
  return out;
}
function stableJSON(v) {
  if (v instanceof Date) return JSON.stringify(v.toISOString() + (v.dateOnly ? '/day' : ''));
  if (Array.isArray(v)) return '[' + v.map(stableJSON).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stableJSON(v[k]); }).join(',') + '}';
  return JSON.stringify(v);
}

// ======================================================================
// System tools: curl for HTTPS, security for the Keychain, open for the browser
// ======================================================================
// Run a binary with stdin input; secrets travel on stdin, never in arguments (visible in ps).
function exec(path, args, input, timeoutS) { // → {code, out, err, outData}
  var t = $.NSTask.alloc.init, i = $.NSPipe.pipe, o = $.NSPipe.pipe, e = $.NSPipe.pipe;
  t.launchPath = path; t.arguments = $(args); t.standardInput = i; t.standardOutput = o; t.standardError = e;
  t.launch;
  if (input) safe(function () { i.fileHandleForWriting.writeData($(input).dataUsingEncoding($.NSUTF8StringEncoding)); });
  safe(function () { i.fileHandleForWriting.closeFile; });
  var od = o.fileHandleForReading.readDataToEndOfFile, ed = e.fileHandleForReading.readDataToEndOfFile;
  t.waitUntilExit;
  function str(d) { return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding)) || ''; }
  return { code: Number(t.terminationStatus), out: str(od), err: str(ed), outData: od };
}
function curlQuote(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'; }

// One HTTP request. req: {method, url, headers{}, form{} (repeatable values as arrays), json, multipart [{name, value | file, filename}],
// out (save body to this path), maxBytes, timeout}. → {status, text, json, saved, curl}. Tests replace this function.
function curlConfig(req) {
  var cfg = ['silent', 'show-error', 'max-time = ' + (req.timeout || HTTP_TIMEOUT_S), 'request = ' + curlQuote(req.method || 'GET'), 'url = ' + curlQuote(req.url)];
  Object.keys(req.headers || {}).forEach(function (k) { cfg.push('header = ' + curlQuote(k + ': ' + req.headers[k])); });
  if (req.form) Object.keys(req.form).forEach(function (k) {
    [].concat(req.form[k]).forEach(function (v) { cfg.push('data-urlencode = ' + curlQuote(k + '=' + v)); });
  });
  if (req.json !== undefined) { cfg.push('header = "Content-Type: application/json"'); cfg.push('data-binary = ' + curlQuote(JSON.stringify(req.json))); }
  (req.multipart || []).forEach(function (p) {
    if (!p.file) return cfg.push('form-string = ' + curlQuote(p.name + '=' + p.value));
    // the -F grammar is parsed again inside the config value: quote the path and the file name, escaping " and \
    var fq = function (x) { return '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; };
    cfg.push('form = ' + curlQuote(p.name + '=@' + fq(p.file) + (p.filename ? ';filename=' + fq(p.filename) : '')));
  });
  if (req.out) cfg.push('output = ' + curlQuote(req.out));
  if (req.maxBytes) cfg.push('max-filesize = ' + req.maxBytes);
  cfg.push('proto = "=https,http"');
  cfg.push('write-out = "\\n%{http_code}"');
  return cfg.join('\n') + '\n';
}
function http(req) {
  // -q first: a user's ~/.curlrc must not add proxies, "insecure", output files or other URLs to these requests
  var r = exec('/usr/bin/curl', ['-q', '-K', '-'], curlConfig(req));
  if (r.code !== 0) return { status: 0, curl: r.code, text: r.err.trim() };
  var nl = r.out.lastIndexOf('\n'), text = r.out.slice(0, nl), status = Number(r.out.slice(nl + 1)) || 0;
  return { status: status, text: text, json: safe(function () { return JSON.parse(text); }, undefined), saved: req.out || null };
}
// A URL the server handed back (download/upload links, the sign-in page) must be plain https on a known host.
function serverURL(u, what, sameOrigin) {
  var s = String(u || ''), m = /^(https?):\/\/([^\/?#@\s]+)(\/[^\s]*)?$/i.exec(s);
  var base = SESSION.server || currentServer(), bm = /^(https?):\/\/([^\/]+)/i.exec(base);
  if (!m || (m[1].toLowerCase() !== 'https' && !isLocalHost(m[2])) || (sameOrigin && bm && lower(m[2]) !== lower(bm[2])))
    fail('The server returned an unexpected ' + what + ' address, so it was not used.', 'Check that ' + base + ' is really your Seafile server.');
  return s;
}
function isLocalHost(host) { return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host); }

// Keychain: one generic password per server (service seafile-mcp, account = server URL, secret = API token).
var KEYCHAIN_SERVICE = 'seafile-mcp';
function secretGet(account) {
  var r = exec('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w']);
  return r.code === 0 ? r.out.replace(/\n$/, '') : null;
}
function secretSet(account, value) {
  var r = exec('/usr/bin/security', ['-i'], 'add-generic-password -U -s ' + curlQuote(KEYCHAIN_SERVICE) + ' -a ' + curlQuote(account) + ' -w ' + curlQuote(value) + '\n');
  if (r.code !== 0) fail('Could not save the sign-in to the Keychain: ' + (r.err.trim() || 'security exited ' + r.code) + '.');
}
function secretDelete(account) { exec('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]); }
function openURL(url) { exec('/usr/bin/open', [url]); }

// ======================================================================
// Server, sign-in, API calls
// ======================================================================
var HTTP_TIMEOUT_S = 20;
// The server address is never built in: the setting SEAFILE_URL, or the one remembered at the last sign-in.
var STATE_ACCOUNT = '__server__'; // Keychain item that remembers which server was used last
var SIGNIN_SERVER = ''; // the address given to sign_in, until that sign-in succeeds
function normalServer(s) {
  s = trim(s || '');
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  var m = /^(https?):\/\/([^\/?#\s"'\\<>@]+)(\/[^?#\s"'\\<>]*)?$/i.exec(s);
  if (!m || /[\u0000-\u001f]/.test(s)) fail('"' + s + '" is not a server address.', 'Give it like https://cloud.example.com (no user name or password in it).');
  if (m[1].toLowerCase() !== 'https' && !isLocalHost(m[2])) fail('Only https:// servers are used: the sign-in token must not travel unencrypted.', 'Use https://' + m[2]);
  return m[1].toLowerCase() + '://' + m[2] + (m[3] || '').replace(/\/+$/, '');
}
function currentServer(explicit) {
  var s = normalServer(explicit || SIGNIN_SERVER || env('SEAFILE_URL') || secretGet(STATE_ACCOUNT) || '');
  if (!s) fail('No Seafile server is set yet.', 'Ask the user for the server address, then call read {"action": "sign_in", "args": {"server": "https://…"}}, or set it in the extension settings (SEAFILE_URL).');
  return s;
}
var SESSION = { server: null, token: null, user: null };
function session() {
  var server = currentServer();
  if (SESSION.server === server && SESSION.token) return SESSION;
  LIB_CACHE = { at: 0, list: null };
  var token = secretGet(server);
  if (!token) signIn(server); // opens the browser and fails with "sign in, then ask again" until done
  SESSION = { server: server, token: token || secretGet(server), user: null };
  return SESSION;
}

// Browser sign-in, as the Seafile desktop client does it: the server issues a one-time link, the user signs in on the web
// page (password, SSO, two-factor — whatever the server uses), and this side polls until the server hands over a token.
// The password never passes through this process or the model.
var PENDING_SUFFIX = '#pending';
function signIn(server, waitS) {
  var pending = secretGet(server + PENDING_SUFFIX), deadline = Date.now() + (waitS == null ? 12 : waitS) * 1000;
  if (pending) {
    while (true) {
      var r = http({ url: server + '/api2/client-sso-link/' + pending + '/' });
      var st = r.json && r.json.status;
      if (r.status === 0 || r.status >= 500 || (r.status === 200 && !st)) // a hiccup: keep waiting on the same sign-in
        fail('Could not check the Seafile sign-in just now.', 'Call again in a moment; the sign-in page stays valid for 5 minutes after it was opened.');
      if (st === 'success' && r.json.apiToken) {
        secretSet(server, r.json.apiToken); secretSet(STATE_ACCOUNT, server); secretDelete(server + PENDING_SUFFIX); // remembered only now
        SESSION = { server: server, token: r.json.apiToken, user: r.json.username || null }; SIGNIN_SERVER = '';
        LIB_CACHE = { at: 0, list: null };
        note('Signed in to ' + server + (r.json.username ? ' as ' + r.json.username : '') + '.');
        return SESSION;
      }
      if (st !== 'waiting') { secretDelete(server + PENDING_SUFFIX); break; } // expired or failed: start over
      if (Date.now() > deadline) fail('Waiting for the Seafile sign-in in the browser.', 'Tell the user to finish signing in on the page that opened (' + server + '), then call again. The page works for 5 minutes after it is opened.');
      checkCancelled();
      delay(1);
    }
  }
  var info = http({ method: 'POST', url: server + '/api2/client-sso-link/' });
  if (!info.json || !info.json.link) {
    if (info.status === 0) failNetwork(info, server);
    fail(server + ' does not offer browser sign-in (got HTTP ' + info.status + ').', 'Is this the right Seafile server? Browser sign-in needs CLIENT_SSO_VIA_LOCAL_BROWSER on the server.');
  }
  SESSION.server = server;
  var link = serverURL(info.json.link, 'sign-in page', true), t = link.replace(/\/+$/, '').split('/').pop();
  secretSet(server + PENDING_SUFFIX, t);
  openURL(link);
  fail('A browser window opened to sign in to Seafile (' + server + ').', 'Tell the user to sign in there, then call again — nothing else is needed.');
}
function signOut() {
  var server = currentServer();
  secretDelete(server); secretDelete(server + PENDING_SUFFIX);
  SESSION = { server: null, token: null, user: null }; LIB_CACHE = { at: 0, list: null };
  return { signed_out: server };
}
function failNetwork(r, server) {
  var c = r.curl, why = { 6: 'the server name could not be resolved', 7: 'the server refused the connection', 28: 'the server did not answer in time', 35: 'the secure connection failed', 60: 'the server certificate is not trusted' }[c] || r.text || 'curl exit ' + c;
  fail('Could not reach ' + server + ': ' + why + '.', 'Check the address and that this Mac is online' + (c === 60 ? '; the certificate must be valid' : '') + ', then try again.');
}

// Authenticated API call. path is relative to the server ("/api2/…"). Turns HTTP errors into plain-words errors.
function api(method, path, opts) {
  opts = opts || {};
  var s = session(), q = opts.query ? '?' + Object.keys(opts.query).filter(function (k) { return opts.query[k] != null; }).map(function (k) {
    return [].concat(opts.query[k]).map(function (v) { return encodeURIComponent(k) + '=' + encodeURIComponent(v); }).join('&');
  }).join('&') : '';
  var r = http({ method: method, url: s.server + path + q, headers: { Authorization: 'Token ' + s.token, Accept: 'application/json' },
    form: opts.form, json: opts.json, timeout: opts.timeout });
  if (r.status === 0) failNetwork(r, s.server);
  if (r.status === 401) { secretDelete(s.server); SESSION = { server: null, token: null, user: null }; signIn(s.server, 0); }
  if (r.status >= 200 && r.status < 300) return r.json !== undefined ? r.json : r.text;
  var msg = (r.json && (r.json.error_msg || r.json.detail)) || (r.text || '').slice(0, 200) || 'HTTP ' + r.status;
  if (opts.allow && opts.allow.indexOf(r.status) >= 0) return { __status: r.status, error: msg };
  if (r.status === 400 && /name invalid|invalid.*name/i.test(msg))
    fail('Seafile does not accept this name.', 'Seafile refuses some characters in names — emoji, symbols like ✓, and \\. Letters in any language, digits, spaces and & # % ? " * : | are fine.');
  var hint = { 403: 'Your account has no permission for this here.', 404: 'Check the library and path (list_libraries, list_folder).', 429: 'Seafile is throttling requests; wait a little, then try once more.',
    440: 'The library is encrypted: unlock it in the Seafile web page first.', 441: 'The library is encrypted: unlock it in the Seafile web page first.', 443: 'The account is out of storage quota.',
    447: 'The library has too many files for this operation.', 423: 'The file is locked by someone else.', 520: 'Seafile could not do it; try again, or do it in the web page.' }[r.status] || 'Try again; if it repeats, tell the user what failed.';
  fail('Seafile said: ' + msg + ' (HTTP ' + r.status + ').', hint);
}

// ======================================================================
// Libraries and paths
// ======================================================================
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var LIB_CACHE = { at: 0, list: null };
function libraries() {
  if (LIB_CACHE.list && Date.now() - LIB_CACHE.at < 30e3) return LIB_CACHE.list;
  var r = api('GET', '/api/v2.1/repos/');
  LIB_CACHE = { at: Date.now(), list: (r.repos || []).map(function (x) {
    return { id: x.repo_id, name: x.repo_name, type: x.type, size: x.size, encrypted: !!x.encrypted, permission: x.permission,
      owner: x.owner_email || x.owner_name || (x.group_name ? 'group ' + x.group_name : null), modified: x.last_modified || null };
  }) };
  return LIB_CACHE.list;
}
// A library by id or name (case-insensitive). Two with the same name: ask for the id.
function library(want) {
  var list = libraries(), w = trim(want);
  if (UUID.test(w)) { var byId = list.filter(function (l) { return l.id === w; })[0]; if (byId) return byId; fail('No library with id ' + w + '.', 'Ids come from list_libraries.'); }
  var nw = w.normalize('NFC'), hits = list.filter(function (l) { return String(l.name).normalize('NFC') === nw; });
  if (!hits.length) hits = list.filter(function (l) { return lower(String(l.name).normalize('NFC')) === lower(nw); });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) fail('Several libraries are named "' + w + '": ' + hits.map(function (l) { return l.id + ' (' + (l.owner || l.type) + ')'; }).join(', ') + '.', 'Pass the library id instead of the name.');
  fail('No library "' + w + '".' + didYouMean(w, list.map(function (l) { return l.name; })), 'Libraries: ' + list.map(function (l) { return l.name; }).slice(0, 40).join(', ') + '.');
}
function writable(lib) { if (!/w/.test(lib.permission || '')) fail('Library "' + lib.name + '" is read-only for this account.'); }
function notEncrypted(lib, what) { if (lib.encrypted) fail('Library "' + lib.name + '" is encrypted, so ' + what + ' cannot be done here.', 'Use the Seafile web page or desktop client for encrypted libraries.'); }
// "/a/b", "a/b/", "\\a\\b" → "/a/b"; ".." is refused.
function cleanPath(p) {
  var s = '/' + String(p == null ? '' : p).replace(/\\/g, '/').split('/').filter(function (x) { return x && x !== '.'; }).join('/');
  if (/(^|\/)\.\.(\/|$)/.test(s)) fail('".." is not allowed in paths.', 'Give the full path from the library root, e.g. /Projects/report.pdf');
  return s;
}
function checkName(name, what) { // the rules Seafile is known to enforce; the rest is left to the server
  if (!name || name === '.' || name === '..') fail('"' + name + '" is not a usable ' + what + '.');
  if (/[\\\/]/.test(name)) fail(what + ' "' + name + '" contains a slash or backslash.', 'Seafile does not allow \\ in names; / separates folders.');
  if (name.length > 255) fail(what + ' is longer than 255 characters.');
}
function parentOf(p) { var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
function baseName(p) { return p.slice(p.lastIndexOf('/') + 1); }
function isoFromUnix(t) { return t ? new Date(t * 1000).toISOString() : null; }
function insideLocal(dirArg, base, what) { // a local folder inside the configured one, or the configured one
  var dir = base;
  if (dirArg) {
    dir = stdPath(/^[\/~$]/.test(dirArg) ? dirArg : base + '/' + dirArg);
    if (dir !== base && dir.indexOf(base + '/') !== 0) fail(what + ' only inside ' + base + ' (the local folder in the extension settings).', 'Leave the folder out, or give a subfolder name like "reports".');
  }
  return dir;
}
function entry(lib, path) { // {type:'file'|'dir', ...} or null
  if (path === '/') return { type: 'dir', name: '/', path: '/' };
  var parent = parentOf(path), name = baseName(path);
  var r = api('GET', '/api/v2.1/repos/' + lib.id + '/dir/', { query: { p: parent }, allow: [404] });
  if (r.__status) return null;
  var want = name.normalize('NFC'), e = (r.dirent_list || []).filter(function (x) { return String(x.name).normalize('NFC') === want; })[0];
  return e ? { type: e.type === 'dir' ? 'dir' : 'file', name: e.name, path: path, size: e.size, mtime: e.mtime } : null;
}
function mustExist(lib, path) {
  var e = entry(lib, path);
  if (!e) fail('Nothing at ' + path + ' in "' + lib.name + '".', 'Check the path with list_folder or search.');
  return e;
}
// Deleted items are recoverable only while the library keeps history; keep_days 0 means they are gone for good.
// Only explicit evidence counts: keep_days -1 (forever) or > 0 from the owner's view, or the trash saying it can be searched.
function deletesRecoverable(lib) {
  var h = api('GET', '/api2/repos/' + lib.id + '/history-limit/', { allow: [403, 404] });
  if (!h.__status) return typeof h.keep_days === 'number' && (h.keep_days === -1 || h.keep_days > 0);
  var t = api('GET', '/api/v2.1/repos/' + lib.id + '/trash2/', { query: { page: 1, per_page: 1 }, allow: [403, 404] });
  return !t.__status && t.can_search === true;
}
function mustKeepHistory(lib, what) {
  if (!deletesRecoverable(lib)) fail('Library "' + lib.name + '" keeps no file history (or it could not be confirmed), so ' + what + ' could not be undone. Nothing was changed.', 'The user can do it in the Seafile web page.');
}
var TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|toml|ini|cfg|conf|log|html?|css|js|ts|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sh|zsh|sql|tex|rst|srt|vtt|env|properties)$/i;

var SEAFILE = {
  sign_in: function (a) {
    if (a.server) SIGNIN_SERVER = normalServer(a.server);
    var server = currentServer(); // a new address is remembered only once the sign-in succeeds
    var token = secretGet(server);
    if (token && !a.again) {
      SESSION = { server: server, token: token, user: null };
      var me = api('GET', '/api2/account/info/');
      return { signed_in: true, server: server, user: me.contact_email || me.login_id || me.email, name: me.name };
    }
    if (a.again) secretDelete(server);
    var s = signIn(server);
    return { signed_in: true, server: s.server, user: s.user };
  },
  status: function () {
    var s = session(), me = api('GET', '/api2/account/info/');
    return { server: s.server, user: me.contact_email || me.login_id || me.email, name: me.name, quota_bytes: me.total > 0 ? me.total : null, used_bytes: me.usage, used: me.space_usage };
  },
  list_libraries: function (a) {
    var list = libraries().filter(function (l) { return !a.type || l.type === a.type; });
    if (a.query) list = list.filter(function (l) { return lower(l.name).indexOf(lower(a.query)) >= 0; });
    return list.slice(0, a.limit);
  },
  list_folder: function (a) {
    var lib = library(a.library), p = cleanPath(a.path);
    var r = api('GET', '/api/v2.1/repos/' + lib.id + '/dir/', { query: { p: p, t: a.only === 'files' ? 'f' : a.only === 'folders' ? 'd' : null } });
    var items = (r.dirent_list || []).map(function (e) {
      var o = { type: e.type === 'dir' ? 'folder' : 'file', name: e.name, path: (p === '/' ? '' : p) + '/' + e.name, modified: isoFromUnix(e.mtime) };
      if (e.type !== 'dir') { o.size = e.size; o.modified_by = e.modifier_name || e.modifier_email || null; }
      return o;
    }).sort(function (x, y) { return x.type === y.type ? (x.name < y.name ? -1 : 1) : (x.type === 'folder' ? -1 : 1); });
    if (items.length > a.offset + a.limit) note('Showing ' + (a.offset + 1) + '–' + (a.offset + a.limit) + ' of ' + items.length + '; call again with offset ' + (a.offset + a.limit) + ' for more.');
    return { library: lib.name, path: p, total: items.length, items: items.slice(a.offset, a.offset + a.limit) };
  },
  search: function (a) {
    var libs = a.library ? [library(a.library)] : libraries(), out = [], MAX_LIBS = 25;
    if (libs.length > MAX_LIBS) { note('Searched the first ' + MAX_LIBS + ' of ' + libs.length + ' libraries; pass "library" to search one.'); libs = libs.slice(0, MAX_LIBS); }
    libs.forEach(function (lib) {
      checkCancelled();
      var r = api('GET', '/api/v2.1/search-file/', { query: { repo_id: lib.id, q: a.query }, allow: [403, 404, 400] });
      if (r.__status) return;
      (r.data || []).forEach(function (x) { out.push({ library: lib.name, path: x.path, type: x.type, size: x.size, modified: x.mtime }); });
    });
    note('Search matches file and folder names, not the text inside files.');
    return out.slice(0, a.limit);
  },
  file_info: function (a) {
    var lib = library(a.library), p = cleanPath(a.path), e = mustExist(lib, p);
    if (e.type === 'dir') return { library: lib.name, path: p, type: 'folder' };
    var d = api('GET', '/api2/repos/' + lib.id + '/file/detail/', { query: { p: p } });
    return { library: lib.name, path: p, type: 'file', size: d.size, modified: d.last_modified || isoFromUnix(d.mtime), modified_by: d.last_modifier_name || d.last_modifier_email || null, can_edit: d.can_edit };
  },
  read_file: function (a) {
    var lib = library(a.library), p = cleanPath(a.path), e = mustExist(lib, p);
    if (e.type === 'dir') fail(p + ' is a folder.', 'Use list_folder for folders.');
    notEncrypted(lib, 'reading files');
    var MAX = 5 * 1024 * 1024;
    if (e.size > MAX) fail(p + ' is ' + Math.round(e.size / 1048576) + ' MB, too big to read here.', 'Use download_file to save it locally.');
    var url = serverURL(api('GET', '/api2/repos/' + lib.id + '/file/', { query: { p: p } }), 'download');
    var r = http({ url: url, timeout: 60, maxBytes: MAX });
    if (r.curl === 63) fail(p + ' is bigger than 5 MB, too big to read here.', 'Use download_file to save it locally.');
    if (r.status !== 200) fail('Could not download ' + p + ' (HTTP ' + r.status + ').');
    if (!TEXT_EXT.test(p) && /[\u0000-\u0008\u000e-\u001f]/.test(r.text.slice(0, 4096))) fail(p + ' is not a text file.', 'Use download_file to save it, then open it with a suitable app.');
    var body = page(r.text, a.offset, a.max_chars);
    return { library: lib.name, path: p, size: e.size, text: body.text, total_chars: body.total_chars, next_offset: body.next_offset };
  },
  file_history: function (a) {
    var lib = library(a.library), p = cleanPath(a.path);
    var r = api('GET', '/api/v2.1/repos/' + lib.id + '/file/history/', { query: { path: p, limit: a.limit } });
    return (r.data || []).map(function (v) { return { commit_id: v.commit_id, time: v.ctime, size: v.size, by: v.creator_email, what: v.description, renamed_from: v.rev_renamed_old_path || undefined }; });
  },
  list_trash: function (a) {
    var lib = library(a.library), r = api('GET', '/api/v2.1/repos/' + lib.id + '/trash/', { query: { path: cleanPath(a.path), show_days: 0 } });
    var items = (r.data || []).map(function (x) { return { path: (x.parent_dir === '/' ? '' : x.parent_dir.replace(/\/$/, '')) + '/' + x.obj_name, type: x.is_dir ? 'folder' : 'file', deleted: x.deleted_time, size: x.size, commit_id: x.commit_id }; });
    if (r.more) note('There are more deleted items than shown.');
    return items.slice(0, a.limit);
  },
  list_share_links: function (a) {
    var lib = a.library ? library(a.library) : null;
    var r = api('GET', '/api/v2.1/share-links/', { query: { repo_id: lib && lib.id, path: lib && a.path ? cleanPath(a.path) : null, per_page: a.limit } });
    return (Array.isArray(r) ? r : []).map(shareOut);
  },

  download_file: function (a) {
    var lib = library(a.library), p = cleanPath(a.path), e = mustExist(lib, p);
    if (e.type === 'dir') fail(p + ' is a folder; only files can be downloaded here.');
    notEncrypted(lib, 'downloading');
    var dir = insideLocal(a.to, LOCAL_DIR, 'Files are saved');
    if (!$.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $())) fail('Could not create ' + dir + '.');
    var url = serverURL(api('GET', '/api2/repos/' + lib.id + '/file/', { query: { p: p } }), 'download'), tmp = privateTemp('download');
    checkCancelled();
    var r = http({ url: url, out: tmp, timeout: CALL_TIMEOUT_S - 2 });
    if (r.status !== 200) { removeQuietly(tmp); fail('Could not download ' + p + (r.status ? ' (HTTP ' + r.status + ')' : r.curl === 28 ? ' in time' : '') + '.'); }
    var target = placeWithoutReplacing(tmp, dir, baseName(p));
    return { saved: target, size: e.size, from: lib.name + ':' + p };
  },
  upload_file: function (a) {
    var lib = library(a.library), dir = cleanPath(a.to_folder), local = insideLocal(a.file, LOCAL_DIR, 'Files can be uploaded');
    writable(lib); notEncrypted(lib, 'uploading');
    if (!$.NSFileManager.defaultManager.fileExistsAtPath(local)) fail('No local file ' + local + '.', 'Files to upload must be inside ' + LOCAL_DIR + '.');
    var name = baseName(local), existing = entry(lib, (dir === '/' ? '' : dir) + '/' + name);
    checkName(name, 'File name');
    if (existing && !a.replace) fail(dir + '/' + name + ' already exists in "' + lib.name + '". Nothing was uploaded.', 'Pass replace:true to upload it as a new version (the old one stays in the file history).');
    if (existing) mustKeepHistory(lib, 'replacing the file');
    if (a.dry_run) return { dry_run: true, would_upload: local, to: lib.name + ':' + (dir === '/' ? '' : dir) + '/' + name, replaces: !!existing };
    var got = uploadAs(lib, dir, local, name, a.replace);
    return { uploaded: lib.name + ':' + (dir === '/' ? '' : dir) + '/' + got.name, size: got.size, replaced: !!existing };
  },
  write_text_file: function (a) {
    var lib = library(a.library), p = cleanPath(a.path), dir = parentOf(p), name = baseName(p);
    writable(lib); notEncrypted(lib, 'writing files');
    var existing = entry(lib, p);
    if (existing && existing.type === 'dir') fail(p + ' is a folder.');
    if (existing && !a.replace) fail(p + ' already exists. Nothing was written.', 'Pass replace:true to save a new version (the old one stays in the file history).');
    if (existing) mustKeepHistory(lib, 'replacing the file');
    checkName(name, 'File name');
    if (a.dry_run) return { dry_run: true, would_write: lib.name + ':' + p, chars: a.text.length, replaces: !!existing };
    var tmp = privateTemp('text');
    if (!$(a.text).writeToFileAtomicallyEncodingError(tmp, true, $.NSUTF8StringEncoding, $())) fail('Could not prepare the text locally. Nothing was written.');
    try {
      checkCancelled();
      var r;
      if (existing) {
        var up = serverURL(api('GET', '/api2/repos/' + lib.id + '/update-link/', { query: { p: dir } }), 'upload');
        r = http({ method: 'POST', url: up, multipart: [{ name: 'file', file: tmp, filename: name.replace(/"/g, '_') }, { name: 'target_file', value: p }] });
        if (r.status !== 200) fail('Saving failed (' + (r.status ? 'HTTP ' + r.status : 'no answer') + ').', 'Check with list_folder before trying again.');
      } else uploadAs(lib, dir, tmp, name, false);
    } finally { removeQuietly(tmp); }
    return { written: lib.name + ':' + p, chars: a.text.length, replaced: !!existing };
  },
  create_folder: function (a) {
    var lib = library(a.library), p = cleanPath(a.path);
    writable(lib);
    if (p === '/') fail('Give the folder path, e.g. /Projects/2026.');
    p.split('/').filter(Boolean).forEach(function (x) { checkName(x, 'Folder name'); });
    if (entry(lib, p)) fail(p + ' already exists in "' + lib.name + '".');
    api('POST', '/api2/repos/' + lib.id + '/dir/', { query: { p: p }, form: { operation: 'mkdir', create_parents: 'true' } });
    var made = entry(lib, p);
    if (!made) note('Seafile reported success, but ' + p + ' is not listed yet (it may have been named differently); check list_folder.');
    return { created: lib.name + ':' + p };
  },
  rename: function (a) {
    var lib = library(a.library), p = cleanPath(a.path), e = mustExist(lib, p);
    writable(lib);
    if (/\//.test(a.new_name)) fail('new_name is a name, not a path.', 'To move it somewhere else, use move.');
    checkName(a.new_name, 'The new name');
    if (p === '/') fail('The library root cannot be renamed here.');
    if (entry(lib, (parentOf(p) === '/' ? '' : parentOf(p)) + '/' + a.new_name)) fail('"' + a.new_name + '" already exists next to it. Nothing was renamed.');
    var r = api('POST', '/api/v2.1/repos/' + lib.id + '/' + (e.type === 'dir' ? 'dir' : 'file') + '/', { query: { p: p }, form: { operation: 'rename', newname: a.new_name } });
    var got = (r && r.obj_name) || a.new_name;
    if (got !== a.new_name) note('Seafile named it "' + got + '".');
    return { renamed: lib.name + ':' + p, to: (parentOf(p) === '/' ? '' : parentOf(p)) + '/' + got };
  },
  move: function (a) { return moveOrCopy(a, 'move'); },
  copy: function (a) { return moveOrCopy(a, 'copy'); },
  // Into the library's trash, and only where the library keeps history so it can be restored.
  'delete': function (a) {
    var lib = library(a.library), paths = a.paths.map(cleanPath);
    writable(lib);
    checkItems(paths, 'deleted');
    var found = paths.map(function (p) { return { p: p, e: entry(lib, p) }; }), missing = found.filter(function (x) { return !x.e; });
    if (missing.length) fail('Not found: ' + missing.map(function (x) { return x.p; }).join(', ') + '. Nothing was deleted.', 'Check the paths with list_folder.');
    mustKeepHistory(lib, 'deleting');
    if (a.dry_run) return { dry_run: true, would_move_to_trash: found.map(function (x) { return { path: x.p, type: x.e.type === 'dir' ? 'folder' : 'file', size: x.e.size }; }) };
    var byParent = {};
    found.forEach(function (x) { (byParent[parentOf(x.p)] = byParent[parentOf(x.p)] || []).push(baseName(x.p)); });
    Object.keys(byParent).forEach(function (parent) { checkCancelled(); api('DELETE', '/api/v2.1/repos/batch-delete-item/', { json: { repo_id: lib.id, parent_dir: parent, dirents: byParent[parent] } }); });
    note('Deleted items are in the library trash (list_trash) and can be put back with restore.');
    return { moved_to_trash: paths, library: lib.name };
  },
  restore: function (a) {
    var lib = library(a.library), p = cleanPath(a.path);
    writable(lib);
    var trash = api('GET', '/api/v2.1/repos/' + lib.id + '/trash/', { query: { path: '/', show_days: 0 } }).data || [];
    var hits = trash.filter(function (x) { return (x.parent_dir === '/' ? '' : x.parent_dir.replace(/\/$/, '')) + '/' + x.obj_name === p; });
    if (a.commit_id) hits = hits.filter(function (x) { return x.commit_id === a.commit_id; });
    if (!hits.length) fail(p + ' is not in the trash of "' + lib.name + '".', 'See list_trash for what can be restored.');
    if (hits.length > 1) fail(p + ' was deleted ' + hits.length + ' times; say which one.', 'Pass commit_id from list_trash: ' + hits.map(function (h) { return h.commit_id + ' (' + h.deleted_time + ')'; }).join(', ') + '.');
    if (entry(lib, p)) fail('Something already exists at ' + p + '. Nothing was restored.', 'Rename or move it first.');
    var r = api('POST', '/api/v2.1/repos/' + lib.id + '/trash/revert-dirents/', { form: { path: [p], commit_id: hits[0].commit_id } });
    var failed = (r && r.failed) || [];
    if (failed.length) fail('Seafile could not restore ' + p + ': ' + (failed[0].error_msg || 'unknown error') + '.');
    return { restored: lib.name + ':' + p };
  },
  revert_file: function (a) {
    var lib = library(a.library), p = cleanPath(a.path);
    writable(lib); mustExist(lib, p);
    api('PUT', '/api2/repos/' + lib.id + '/file/revert/', { form: { p: p, commit_id: a.commit_id } });
    note('The version from before the revert stays in the file history.');
    return { reverted: lib.name + ':' + p, to_version: a.commit_id };
  },
  create_share_link: function (a) {
    var lib = library(a.library), p = cleanPath(a.path);
    notEncrypted(lib, 'sharing');
    mustExist(lib, p);
    var form = { repo_id: lib.id, path: p, permissions: JSON.stringify({ can_edit: false, can_download: a.can_download, can_upload: !!a.can_upload }) };
    if (a.password) form.password = a.password;
    if (a.expire_days > 0) form.expire_days = a.expire_days;
    if (a.dry_run) return { dry_run: true, would_share: lib.name + ':' + p, password: !!a.password, expire_days: a.expire_days > 0 ? a.expire_days : 'never', can_download: a.can_download, can_upload: !!a.can_upload };
    var r = api('POST', '/api/v2.1/share-links/', { form: form });
    note('Anyone with this link can open it' + (a.password ? ' with the password' : '') + '. delete_share_link removes it.');
    return shareOut(r);
  },
  delete_share_link: function (a) {
    var mine = api('GET', '/api/v2.1/share-links/', { query: { per_page: 200 } }), t = trim(a.token).replace(/^.*\/(?:d|f)\/([^\/]+)\/?$/, '$1');
    var hit = (Array.isArray(mine) ? mine : []).filter(function (x) { return x.token === t; })[0];
    if (!hit) fail('No share link of yours with token ' + t + '.', 'See list_share_links.');
    api('DELETE', '/api/v2.1/share-links/' + t + '/');
    return { deleted_link: hit.link, path: hit.path };
  },
  sign_out: function () { return signOut(); }
};
function shareOut(x) {
  return { token: x.token, link: x.link, path: x.path, library_id: x.repo_id, folder: !!x.is_dir, expires: x.expire_date || null, expired: !!x.is_expired,
    password: !!x.password, views: x.view_cnt, can_download: x.permissions ? x.permissions.can_download : undefined, can_upload: x.permissions ? x.permissions.can_upload : undefined };
}
// Upload localFile into dir as wantedName. curl percent-encodes some characters (") in multipart file names, and
// Seafile would keep them encoded, so such files go up under a plain staging name and are renamed right after.
function uploadAs(lib, dir, localFile, wantedName, replace) {
  checkName(wantedName, 'File name');
  var plain = !/["\r\n]/.test(wantedName), stage = plain ? localFile : privateTemp('upload');
  if (!plain && !$.NSFileManager.defaultManager.copyItemAtPathToPathError(localFile, stage, $())) fail('Could not prepare ' + wantedName + ' for upload. Nothing was uploaded.');
  try {
    var link = serverURL(api('GET', '/api2/repos/' + lib.id + '/upload-link/', { query: { p: dir, replace: replace ? 1 : null } }), 'upload');
    checkCancelled();
    var parts = [{ name: 'file', file: stage }, { name: 'parent_dir', value: dir }, { name: 'replace', value: replace ? '1' : '0' }];
    if (plain && baseName(localFile) !== wantedName) parts[0].filename = wantedName;
    var r = http({ method: 'POST', url: link + '?ret-json=1', multipart: parts, timeout: CALL_TIMEOUT_S - 2 });
    if (r.status !== 200) fail('Upload failed (' + (r.status ? 'HTTP ' + r.status + ': ' + String(r.text).slice(0, 120) : 'no answer in time') + ').', 'It may or may not have arrived: check with list_folder before trying again.');
    var got = ((r.json || [])[0] || {}), stored = got.name || baseName(stage);
    if (!plain) {
      var from = (dir === '/' ? '' : dir) + '/' + stored;
      var ren = api('POST', '/api/v2.1/repos/' + lib.id + '/file/', { query: { p: from }, form: { operation: 'rename', newname: wantedName }, allow: [400, 403, 404, 520] });
      if (ren.__status) { api('DELETE', '/api/v2.1/repos/' + lib.id + '/file/', { query: { p: from }, allow: [404] }); fail('Seafile would not take the name "' + wantedName + '": ' + ren.error + '. Nothing was left behind.'); }
      stored = ren.obj_name || wantedName;
    }
    return { name: stored, size: got.size };
  } finally { if (!plain) removeQuietly(stage); }
}
function checkItems(paths, verb) { // no root, no repeats, not a folder together with something inside it
  if (paths.indexOf('/') >= 0) fail('The library root cannot be ' + verb + ' here.');
  paths.forEach(function (p, i) {
    if (paths.indexOf(p) !== i) fail(p + ' is listed twice.');
    paths.forEach(function (q) { if (q !== p && q.indexOf(p + '/') === 0) fail(q + ' is inside ' + p + '; list only one of them.'); });
  });
}
function moveOrCopy(a, op) {
  var lib = library(a.library), dstLib = a.to_library ? library(a.to_library) : lib, paths = a.paths.map(cleanPath), dst = cleanPath(a.to_folder);
  if (op === 'move') writable(lib);
  writable(dstLib);
  checkItems(paths, op === 'move' ? 'moved' : 'copied');
  var found = paths.map(function (p) { return { p: p, e: entry(lib, p) }; }), missing = found.filter(function (x) { return !x.e; });
  if (missing.length) fail('Not found: ' + missing.map(function (x) { return x.p; }).join(', ') + '. Nothing was ' + (op === 'move' ? 'moved' : 'copied') + '.');
  var target = entry(dstLib, dst);
  if (!target || target.type !== 'dir') fail('No folder ' + dst + ' in "' + dstLib.name + '".', 'Create it first with create_folder.');
  paths.forEach(function (p) {
    if (dstLib.id === lib.id && (dst === p || dst.indexOf(p + '/') === 0)) fail('Cannot ' + op + ' ' + p + ' into itself.');
    if (op === 'move' && dstLib.id === lib.id && parentOf(p) === dst) fail(p + ' is already in ' + dst + '.');
  });
  var clash = paths.filter(function (p) { return entry(dstLib, (dst === '/' ? '' : dst) + '/' + baseName(p)); });
  if (clash.length && op === 'move') fail('Already in ' + dst + ': ' + clash.map(baseName).join(', ') + '. Nothing was moved.', 'Rename one of them first.');
  if (clash.length) note('Copies of ' + clash.map(baseName).join(', ') + ' get a " (1)" name, because the names are taken in ' + dst + '.');
  if (a.dry_run) return { dry_run: true, would: op, items: paths, to: dstLib.name + ':' + dst };
  var byParent = {};
  paths.forEach(function (p) { (byParent[parentOf(p)] = byParent[parentOf(p)] || []).push(baseName(p)); });
  var done = [];
  Object.keys(byParent).forEach(function (parent) {
    checkCancelled();
    try { api('POST', '/api/v2.1/repos/sync-batch-' + op + '-item/', { json: { src_repo_id: lib.id, src_parent_dir: parent, src_dirents: byParent[parent], dst_repo_id: dstLib.id, dst_parent_dir: dst } }); }
    catch (e) { if (done.length && e instanceof UserError) fail(e.message + ' Already ' + (op === 'move' ? 'moved' : 'copied') + ': ' + done.join(', ') + '; the rest was not.', 'Check with list_folder before trying again.'); throw e; }
    byParent[parent].forEach(function (n) { done.push((parent === '/' ? '' : parent) + '/' + n); });
  });
  return { done: op, items: paths, to: dstLib.name + ':' + dst };
}
// Local files: private temp names, and a final move that never replaces or follows anything already there
// (a dangling symlink counts as taken, so a planted link cannot redirect the file outside the folder).
function privateTemp(kind) {
  var fm = $.NSFileManager.defaultManager;
  if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(TMP_DIR, true, $({ NSFilePosixPermissions: 448 }), $())) fail('Could not create a temporary folder.');
  return TMP_DIR + '/' + kind + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e9) + '.part';
}
function removeQuietly(p) { safe(function () { $.NSFileManager.defaultManager.removeItemAtPathError(p, $()); }); }
function taken(p) { // exists, or is a symlink (even one pointing nowhere)
  return $.NSFileManager.defaultManager.fileExistsAtPath(p) || !!ObjC.unwrap($.NSFileManager.defaultManager.destinationOfSymbolicLinkAtPathError(p, $()));
}
function placeWithoutReplacing(tmp, dir, name) {
  var fm = $.NSFileManager.defaultManager, clean = String(name || 'file').replace(/[\/:]/g, '_').replace(/^\.+/, '_');
  var dot = clean.lastIndexOf('.'), base = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
  for (var n = 0; n < 1000; n++) {
    var p = dir + '/' + (n ? base + ' (' + n + ')' + ext : clean);
    if (taken(p)) continue;
    if (fm.moveItemAtPathToPathError(tmp, p, $())) return p; // fails instead of replacing if something appeared meanwhile
  }
  removeQuietly(tmp);
  fail('Could not find a free file name in ' + dir + '.');
}

// ======================================================================
// ACTIONS — the one registry. tool: read|write; guard: refuse exact repeats; args: specs (see coerce).
// ======================================================================
var LIB = { type: 'string', required: true, desc: 'library name or id (list_libraries)' };
function LIMIT(d, max) { return { type: 'integer', 'default': d, min: 1, max: max || 200, desc: 'default ' + d }; }
var PAGE = { offset: { type: 'integer', 'default': 0, min: 0 }, max_chars: { type: 'integer', 'default': 12000, min: 200, max: 100000 } };
var DRY = { type: 'boolean', 'default': false };

var ACTIONS = {
  sign_in: { tool: 'read', desc: 'Connect to the Seafile server (opens the browser once). Other actions do this by themselves when needed.',
    args: { server: { type: 'string', desc: 'https://… ; only the first time' }, again: { type: 'boolean', 'default': false, desc: 'sign in again, e.g. as another user' } }, run: SEAFILE.sign_in },
  status: { tool: 'read', desc: 'Who is signed in, on which server, storage used.', args: {}, run: SEAFILE.status },
  list_libraries: { tool: 'read', desc: 'Libraries you can see, with permission (rw/r), size and owner.',
    args: { type: { type: 'string', values: ['mine', 'shared', 'group', 'public'] }, query: { type: 'string', desc: 'name contains' }, limit: LIMIT(100, 500) }, run: SEAFILE.list_libraries },
  list_folder: { tool: 'read', desc: 'Files and folders in a library folder, folders first.',
    args: { library: LIB, path: { type: 'string', 'default': '/' }, only: { type: 'string', values: ['files', 'folders'] }, limit: LIMIT(100, 500), offset: { type: 'integer', 'default': 0, min: 0 } }, run: SEAFILE.list_folder },
  search: { tool: 'read', desc: 'Find files and folders by name (not by content), in one library or all.',
    args: { query: { type: 'string', required: true }, library: { type: 'string' }, limit: LIMIT(50) }, run: SEAFILE.search },
  file_info: { tool: 'read', desc: 'Size, last change and who made it.', args: { library: LIB, path: { type: 'string', required: true } }, run: SEAFILE.file_info },
  read_file: { tool: 'read', desc: 'Text of a text file (up to 5 MB), paged with offset.', args: ext({ library: LIB, path: { type: 'string', required: true } }, PAGE), run: SEAFILE.read_file },
  file_history: { tool: 'read', desc: 'Earlier versions of a file (commit_id for revert_file).', args: { library: LIB, path: { type: 'string', required: true }, limit: LIMIT(20, 100) }, run: SEAFILE.file_history },
  list_trash: { tool: 'read', desc: 'Deleted items that can still be restored.', args: { library: LIB, path: { type: 'string', 'default': '/' }, limit: LIMIT(50, 500) }, run: SEAFILE.list_trash },
  list_share_links: { tool: 'read', desc: 'Your share links, optionally for one library/path.', args: { library: { type: 'string' }, path: { type: 'string' }, limit: LIMIT(50, 200) }, run: SEAFILE.list_share_links },

  download_file: { tool: 'write', guard: true, desc: 'Save a file into the local folder from the settings (default ~/Downloads). Never overwrites.',
    args: { library: LIB, path: { type: 'string', required: true }, to: { type: 'string', desc: 'subfolder of the local folder' } }, run: SEAFILE.download_file },
  upload_file: { tool: 'write', guard: true, desc: 'Upload a local file (only from the local folder in the settings). replace:true makes a new version.',
    args: { library: LIB, file: { type: 'string', required: true, desc: 'local file, inside the local folder' }, to_folder: { type: 'string', 'default': '/', aliases: ['folder', 'dir', 'path', 'remote_path', 'into', 'to'] }, replace: { type: 'boolean', 'default': false }, dry_run: DRY }, run: SEAFILE.upload_file },
  write_text_file: { tool: 'write', guard: true, desc: 'Create a text file from text; replace:true saves a new version of an existing one.',
    args: { library: LIB, path: { type: 'string', required: true }, text: { type: 'string', required: true, raw: true }, replace: { type: 'boolean', 'default': false }, dry_run: DRY }, run: SEAFILE.write_text_file },
  create_folder: { tool: 'write', guard: true, desc: 'Create a folder (and missing parents).', args: { library: LIB, path: { type: 'string', required: true } }, run: SEAFILE.create_folder },
  rename: { tool: 'write', guard: true, desc: 'Rename a file or folder in place.', args: { library: LIB, path: { type: 'string', required: true }, new_name: { type: 'string', required: true } }, run: SEAFILE.rename },
  move: { tool: 'write', guard: true, desc: 'Move files/folders to another folder (or library).',
    args: { library: LIB, paths: { type: 'list', required: true, aliases: ['path', 'file', 'folder', 'item', 'name'] }, to_folder: { type: 'string', required: true }, to_library: { type: 'string' }, dry_run: DRY }, run: SEAFILE.move },
  copy: { tool: 'write', guard: true, desc: 'Copy files/folders to another folder (or library).',
    args: { library: LIB, paths: { type: 'list', required: true, aliases: ['path', 'file', 'folder', 'item', 'name'] }, to_folder: { type: 'string', required: true }, to_library: { type: 'string' }, dry_run: DRY }, run: SEAFILE.copy },
  'delete': { tool: 'write', guard: true, desc: 'Move files/folders to the library trash (restorable). Refuses where the library keeps no history.',
    args: { library: LIB, paths: { type: 'list', required: true, aliases: ['path', 'file', 'folder', 'item', 'name'] }, dry_run: DRY }, run: SEAFILE['delete'] },
  restore: { tool: 'write', guard: true, desc: 'Put a deleted file/folder back from the trash.', args: { library: LIB, path: { type: 'string', required: true }, commit_id: { type: 'string' } }, run: SEAFILE.restore },
  revert_file: { tool: 'write', guard: true, desc: 'Bring back an earlier version of a file (commit_id from file_history).',
    args: { library: LIB, path: { type: 'string', required: true }, commit_id: { type: 'string', required: true } }, run: SEAFILE.revert_file },
  create_share_link: { tool: 'write', guard: true, desc: 'Make a share link (view + download, expires in 30 days by default). dry_run shows it first.',
    args: { library: LIB, path: { type: 'string', required: true }, password: { type: 'string' }, expire_days: { type: 'integer', 'default': 30, min: 0, max: 3650, desc: 'default 30; 0 = never' }, can_download: { type: 'boolean', 'default': true }, can_upload: { type: 'boolean', 'default': false }, dry_run: DRY }, run: SEAFILE.create_share_link },
  delete_share_link: { tool: 'write', guard: true, desc: 'Remove a share link (token or the link itself).', args: { token: { type: 'string', required: true, aliases: ['link', 'url'] } }, run: SEAFILE.delete_share_link },
  sign_out: { tool: 'write', desc: 'Forget the stored sign-in for this server.', args: {}, run: SEAFILE.sign_out }
};
Object.keys(ACTIONS).forEach(function (n) { ACTIONS[n].app = 'Seafile'; });
if (env('SEAFILE_TEST') === '1') ACTIONS.__sleep = { tool: 'read', app: 'Test', desc: 'test only', args: { seconds: { type: 'integer', 'default': 1, max: 600 } },
  run: function (a) { delay(a.seconds); return { slept: a.seconds }; } };

var ACTION_ALIASES = {
  login: 'sign_in', connect: 'sign_in', auth: 'sign_in', whoami: 'status', me: 'status', account: 'status', quota: 'status',
  libraries: 'list_libraries', libs: 'list_libraries', repos: 'list_libraries', list_repos: 'list_libraries',
  ls: 'list_folder', list: 'list_folder', dir: 'list_folder', list_dir: 'list_folder', list_files: 'list_folder', browse: 'list_folder', folder: 'list_folder',
  find: 'search', search_files: 'search', info: 'file_info', stat: 'file_info', cat: 'read_file', read: 'read_file', open: 'read_file', get_file: 'read_file',
  history: 'file_history', versions: 'file_history', trash: 'list_trash', deleted: 'list_trash', links: 'list_share_links', shares: 'list_share_links',
  download: 'download_file', save: 'download_file', upload: 'upload_file', put: 'upload_file', write: 'write_text_file', write_file: 'write_text_file', create_file: 'write_text_file',
  mkdir: 'create_folder', new_folder: 'create_folder', make_folder: 'create_folder', mv: 'move', cp: 'copy', rm: 'delete', remove: 'delete', delete_file: 'delete', delete_files: 'delete',
  undelete: 'restore', restore_file: 'restore', revert: 'revert_file', share: 'create_share_link', create_link: 'create_share_link', unshare: 'delete_share_link',
  logout: 'sign_out', disconnect: 'sign_out'
};
var ALIAS_PRESETS = {};
// ======================================================================
// dispatch
// ======================================================================
function actionsOf(tool) { return Object.keys(ACTIONS).filter(function (n) { return ACTIONS[n].tool === tool; }); }
function exampleCall(name) {
  var spec = ACTIONS[name], ex = {};
  Object.keys(spec.args).filter(function (k) { return spec.args[k].required; }).forEach(function (k) {
    var t = spec.args[k].type;
    ex[k] = t === 'id' ? 123 : t === 'boolean' ? true : t === 'ids' ? [123] : t === 'objects' ? [{ field: 'from', value: 'x' }] : '…';
  });
  return spec.tool + ' {"action": "' + name + '", "args": ' + JSON.stringify(ex) + '}';
}
function resolveAction(tool, raw) {
  if (raw == null || raw === '') fail('Missing "action".', 'Call ' + tool + ' with {"action": "<name>", "args": {…}}. Actions: ' + actionsOf(tool).join(', ') + '.');
  if (typeof raw !== 'string') fail('"action" must be an action name, e.g. "list_messages".');
  var name = snake(trim(raw)), presets = null;
  if (!ACTIONS[name] && ACTION_ALIASES[name]) { presets = ALIAS_PRESETS[name] || null; note('Action "' + raw + '" is "' + ACTION_ALIASES[name] + '".'); name = ACTION_ALIASES[name]; }
  if (!ACTIONS[name]) {
    var g = closest(name, Object.keys(ACTIONS))[0];
    if (g && tool === 'read' && ACTIONS[g].tool === 'read') { note('Action "' + raw + '" is "' + g + '".'); name = g; } // a read is safe to guess
    else fail('Unknown action "' + raw + '".' + (g ? ' Did you mean "' + g + '" (' + ACTIONS[g].tool + ' tool)?' : ''), tool + ' actions: ' + actionsOf(tool).join(', ') + '.');
  }
  if (ACTIONS[name].tool === 'write' && tool !== 'write') {
    if (READ_ONLY) fail('"' + name + '" changes things, and read-only mode is on (extension settings).', 'Tell the user this is disabled.');
    fail('"' + name + '" belongs to the write tool, not read.', 'Call ' + exampleCall(name) + '.');
  }
  return { name: name, presets: presets };
}
function splitInput(input) { // {action, args} from whatever shape the model sent
  if (typeof input === 'string') input = safe(function () { return JSON.parse(input); }, { action: input });
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Call with {"action": "<name>", "args": {…}}.');
  var argKey = ['args', 'params', 'arguments', 'parameters', 'input'].filter(function (k) { return input[k] !== undefined; })[0];
  var args = argKey ? input[argKey] : {};
  if (typeof args === 'string') {
    var parsed = safe(function () { return JSON.parse(args); }, undefined);
    if (parsed === undefined) fail('"args" must be an object like {"id": 123}, got text: ' + args.slice(0, 80));
    args = parsed;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('"args" must be an object like {"id": 123}.');
  args = ext(args, {});
  if (input.action !== undefined && args.action !== undefined && stableJSON(input.action) !== stableJSON(args.action))
    fail('Two different actions: "' + input.action + '" and args.action "' + args.action + '". Give one.');
  var action = input.action !== undefined ? input.action : args.action !== undefined ? args.action : input.name;
  delete args.action;
  var flat = Object.keys(input).filter(function (k) { return k !== 'action' && k !== argKey && !(k === 'name' && input.action === undefined); });
  if (flat.length) {
    flat.forEach(function (k) {
      if (args[k] !== undefined && stableJSON(args[k]) !== stableJSON(input[k])) fail('"' + k + '" is given twice with different values (next to "action" and inside "args"). Give it once, inside "args".');
      args[k] = input[k];
    });
    note('Arguments belong inside "args": {"action": "…", "args": {…}}.');
  }
  return { action: action, args: args };
}

// Small models loop. A guarded write that already succeeded with the same arguments within 15 minutes is
// refused (repeat:true overrides); a read repeated within a minute gets a note to use the earlier result.
// A write that timed out counts as done: it may have happened, so it is not repeated blindly either.
var DONE = [], REPEAT_WINDOW_MS = 15 * 60e3, LAST_READ = { key: null, at: 0 };

// Everything about a call that needs no network: tool, action, arguments, repeat guard.
function prepareCall(tool, input) {
  if (tool !== 'read' && tool !== 'write') fail('No tool "' + tool + '". Tools: read, write.');
  if (tool === 'write' && READ_ONLY) fail('Read-only mode is on (extension settings): changes are disabled.', 'Tell the user; only the read tool works.');
  var call = splitInput(input || {}), found = resolveAction(tool, call.action), spec = ACTIONS[found.name], args = call.args;
  if (found.presets) Object.keys(found.presets).forEach(function (k) { if (args[k] === undefined) args[k] = found.presets[k]; });
  var repeat = args.repeat !== undefined && TRUE_WORDS.test(String(args.repeat));
  delete args.repeat;
  var a = normaliseArgs(args, spec.args, 'args', spec.tool === 'write');
  var key = found.name + ' ' + stableJSON(a), now = Date.now(), guarded = spec.guard && !a.dry_run;
  if (guarded) {
    DONE = DONE.filter(function (d) { return now - d.at < REPEAT_WINDOW_MS; });
    var prev = DONE.filter(function (d) { return d.key === key; })[0];
    if (prev && !repeat) fail('This exact ' + found.name + ' call ' + (prev.uncertain ? 'timed out' : 'already succeeded') + ' ' + Math.max(1, Math.round((now - prev.at) / 60e3)) + ' min ago, so it was not done again.',
      prev.uncertain ? 'It may have happened: check first (e.g. the Sent folder or the calendar). Only if it did not, add "repeat": true to args.'
        : 'Use the earlier result. Only if the user explicitly asked to do it again, add "repeat": true to args.');
  }
  if (spec.tool === 'read') {
    if (LAST_READ.key === key && now - LAST_READ.at < 60e3) note('You just made this same call. Use that result instead of calling again.');
    LAST_READ = { key: key, at: now };
  }
  return { name: found.name, spec: spec, args: args, a: a, key: key, guarded: guarded };
}
function remember(call, uncertain) { if (call.guarded) DONE.push({ key: call.key, at: Date.now(), uncertain: !!uncertain }); }

// In-process call (tests, and the worker process): prepare, run, remember.
function callPublic(tool, input) {
  NOTES = [];
  var call = prepareCall(tool, input);
  if (call.spec.tool === 'write') checkCancelled(); // last chance before anything changes
  var result = call.spec.run(call.a);
  remember(call);
  return result;
}
function formatResult(result) {
  var out = Array.isArray(result) ? { count: result.length, items: result } : (result && typeof result === 'object' ? result : { status: String(result) });
  if (Array.isArray(result) && !result.length) out.guidance = 'Nothing found. Tell the user, or change the search; do not repeat the same call.';
  if (NOTES.length) out.notes = NOTES.slice();
  return JSON.stringify(out, null, 1);
}

function formatError(e) {
  if (e instanceof UserError) return 'Error: ' + e.message + (e.hint ? '\nHow to fix: ' + e.hint : '') + (NOTES.length ? '\nNotes: ' + NOTES.join(' ') : '');
  return 'Error: ' + errorText(e) + '\nHow to fix: Try once more; if it fails again, tell the user what failed.';
}

// ---------- the two public tools ----------
// Compact on purpose: small local models read this on every request.
function signature(n) {
  var a = ACTIONS[n].args;
  return n + '(' + Object.keys(a).map(function (k) {
    var s = a[k], d = s['default'];
    return k + (s.required ? '*' : '') + (s.values ? '=' + s.values.join('|') : d !== undefined && d !== false ? '=' + d : '') + (s.type === 'date' ? ':date' : s.type === 'ids' ? ':[ids]' : '');
  }).join(', ') + ')';
}
function publicTool(name, title, right, wrong, annotations) {
  var names = actionsOf(name);
  return { name: name, annotations: annotations,
    description: title + '\nCall {"action": "<name>", "args": {…}}. *=required, =default. Copy id/account/mailbox from one result row. Dates: ISO 8601, today, tomorrow, "3 days ago".\n' +
      'RIGHT: ' + right + '\nWRONG: ' + wrong + ' (args go inside "args")\n' +
      names.map(function (n) { return '• ' + signature(n) + ' — ' + ACTIONS[n].desc; }).join('\n'),
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', 'enum': names },
      args: { type: 'object', description: 'arguments of the chosen action' } }, required: ['action'] } };
}
var PUBLIC_TOOLS = [
  publicTool('read', 'Read Seafile: libraries, folders, files, search by name, versions, trash, share links. Never changes anything (sign_in only connects).',
    '{"action": "list_folder", "args": {"library": "Projects", "path": "/2026"}}', '{"action": "list_folder", "library": "Projects"}',
    { title: 'Read Seafile files', readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
  publicTool('write', 'Change Seafile: upload, download, write text files, create folders, rename, move, copy, delete to trash, restore, share links.',
    '{"action": "move", "args": {"library": "Projects", "paths": ["/a.pdf"], "to_folder": "/Archive"}}', '{"action": "move", "paths": ["/a.pdf"]}',
    { title: 'Change Seafile files', readOnlyHint: false, destructiveHint: true, openWorldHint: true })
];
if (READ_ONLY) PUBLIC_TOOLS = PUBLIC_TOOLS.filter(function (t) { return t.name === 'read'; });
var INSTRUCTIONS = 'Files in the user\'s Seafile. The read tool looks, the write tool changes. Paths start at the library root, e.g. /Projects/report.pdf. ' +
  'The first call may open a browser window to sign in: then tell the user to sign in there and call again. ' +
  'Never repeat a call that succeeded. If a result has "notes", follow them. Ask the user before deleting, moving or sharing anything they did not clearly ask for.';

// ======================================================================
// JSON-RPC
// ======================================================================
// The server runs as two processes. The main one speaks MCP and never waits on the network, so ping and
// tools/list always answer. A worker process (this same file, SEAFILE_WORKER=1) runs the actions; a call
// that takes longer than CALL_TIMEOUT_S is answered with an error and the worker is restarted.
var PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']; // newest first
var WORKER_MODE = env('SEAFILE_WORKER') === '1';
var CALL_TIMEOUT_S = Math.max(2, Number(env('SEAFILE_TIMEOUT')) || 60); // file transfers need more than API calls

function handle(req) {
  var id = req.id, method = req.method, p = req.params || {};
  try {
    if (method === 'initialize') {
      var want = p.protocolVersion;
      send({ jsonrpc: '2.0', id: id, result: {
        protocolVersion: PROTOCOL_VERSIONS.indexOf(want) >= 0 ? want : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} }, serverInfo: { name: 'seafile-mcp', version: VERSION }, instructions: INSTRUCTIONS } });
      return Worker.warm();
    }
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id: id, result: { tools: PUBLIC_TOOLS } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id: id, result: {} });
    if (method === 'tools/call') {
      var names = PUBLIC_TOOLS.map(function (t) { return t.name; });
      if (typeof p.name !== 'string' || names.indexOf(p.name) < 0)
        return send({ jsonrpc: '2.0', id: id, error: { code: -32602, message: 'Unknown tool: ' + p.name + '. Tools: ' + names.join(', ') + (READ_ONLY ? ' (read-only mode is on)' : '') } });
      if (p.arguments !== undefined && (p.arguments === null || typeof p.arguments !== 'object' || Array.isArray(p.arguments)))
        return send({ jsonrpc: '2.0', id: id, error: { code: -32602, message: 'tools/call arguments must be an object: {"action": "…", "args": {…}}' } });
      var out = toolCall(id, p.name, p.arguments);
      if (out) send({ jsonrpc: '2.0', id: id, result: out });
      return;
    }
    send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    send({ jsonrpc: '2.0', id: id, error: { code: -32603, message: errorText(e) } });
  }
}
function text(t, isError) { var o = { content: [{ type: 'text', text: t }] }; if (isError) o.isError = true; return o; }
// One tools/call: prepared here, run by the worker (or in this process when there is none). null = cancelled.
function toolCall(id, tool, input) {
  NOTES = [];
  var call;
  try { call = prepareCall(tool, input); } catch (e) { return text(formatError(e), true); }
  var app = call.spec.app, label = tool + '.' + call.name + ' [' + app + ']', t0 = Date.now(), r;
  log('→ ' + id + ' ' + label);
  try {
    r = Worker.run(call.name, call.args);
  } catch (e) {
    if (e instanceof Cancelled) { remember(call, true); log('← ' + id + ' ' + call.name + ' cancelled after ' + (Date.now() - t0) + 'ms'); return null; }
    throw e;
  }
  (r.notes || []).forEach(note);
  var ms = Date.now() - t0;
  if (r.timeout || r.died) { // the outcome is unknown: a write may have happened
    remember(call, true);
    log('← ' + id + ' ' + call.name + (r.timeout ? ' TIMEOUT' : ' WORKER DIED') + ' after ' + ms + 'ms');
    return text('Error: ' + (r.timeout ? app + ' did not answer within ' + CALL_TIMEOUT_S + ' s, so the call was stopped.' : 'The process talking to ' + app + ' ended before it answered.') +
      '\nHow to fix: the server or the network may be slow, or a large file is still moving.' +
      (call.spec.tool === 'write' ? ' The change may or may not have happened: check with list_folder, list_trash or list_share_links before trying again.' : ' Then try again, perhaps with a smaller limit or a narrower search.'), true);
  }
  log('← ' + id + ' ' + call.name + ' ' + ms + 'ms ' + (r.error ? 'error' + (r.error.number ? ' ' + r.error.number : '') : 'ok'));
  if (r.error) {
    return text(formatError(r.error.user ? new UserError(r.error.message, r.error.hint) : { message: r.error.message }), true);
  }
  remember(call);
  return text(formatResult(r.value));
}

// ---------- the worker process ----------
var Worker = {
  task: null, input: null, buf: null, replies: [], dead: false, path: null, observer: null,
  selfPath: function () {
    if (this.path !== null) return this.path;
    var args = safe(function () { return ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments); }, []) || [];
    this.path = args.filter(function (x) { return /\.js$/.test(x); }).pop() || '';
    return this.path;
  },
  usable: function () { return !WORKER_MODE && env('SEAFILE_NO_WORKER') !== '1' && !!this.selfPath(); },
  start: function () {
    var t = $.NSTask.alloc.init, envd = $.NSMutableDictionary.dictionaryWithDictionary($.NSProcessInfo.processInfo.environment);
    envd.setObjectForKey($('1'), $('SEAFILE_WORKER'));
    t.launchPath = '/usr/bin/osascript';
    t.arguments = $(['-l', 'JavaScript', this.selfPath()]);
    t.environment = envd;
    var inPipe = $.NSPipe.pipe, outPipe = $.NSPipe.pipe;
    t.standardInput = inPipe; t.standardOutput = outPipe; // stderr is shared, so worker logs reach the client too
    var out = outPipe.fileHandleForReading;
    this.observer = $.SeafileMCPWorkerOut.alloc.init;
    $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(this.observer, 'onData:', $.NSFileHandleReadCompletionNotification, out);
    out.readInBackgroundAndNotify;
    t.launch;
    this.task = t; this.input = inPipe.fileHandleForWriting; this.buf = $.NSMutableData.alloc.init; this.replies = []; this.dead = false;
    log('worker started (pid ' + t.processIdentifier + ')');
  },
  stop: function () {
    if (this.observer) { $.NSNotificationCenter.defaultCenter.removeObserver(this.observer); this.observer = null; }
    if (this.task) {
      var pid = safe(function () { return Number(Worker.task.processIdentifier); }, 0);
      if (pid) safe(function () { exec('/usr/bin/pkill', ['-TERM', '-P', String(pid)]); }); // its curl too, so an upload really stops
      safe(function () { Worker.task.terminate; }); log('worker stopped');
    }
    this.task = null; this.input = null;
  },
  warm: function () { if (this.usable() && !this.task) safe(function () { Worker.start(); }); },
  onData: function (d) {
    if (!d || Number(d.length) === 0) { this.dead = true; return false; }
    this.buf.appendData(d);
    var str = $.NSString.alloc.initWithDataEncoding(this.buf, $.NSUTF8StringEncoding);
    if (str && !str.isNil()) {
      str = str.js;
      var nl = str.lastIndexOf('\n');
      if (nl >= 0) {
        var rest = str.slice(nl + 1);
        this.buf = $.NSMutableData.alloc.init;
        if (rest.length) this.buf.appendData($(rest).dataUsingEncoding($.NSUTF8StringEncoding));
        str.slice(0, nl).split('\n').forEach(function (l) { if (l.trim()) Worker.replies.push(safe(function () { return JSON.parse(l); }, { error: { message: 'bad reply from worker' } })); });
      }
    }
    return true;
  },
  // → {value, notes} | {error: {message, hint, user, number}, notes} | {timeout: true}. Throws Cancelled.
  run: function (name, args) {
    if (!this.usable()) return runAction(name, args);
    if (!this.task || this.dead || !this.task.isRunning) { this.stop(); this.start(); }
    var line = JSON.stringify({ action: name, args: args }, function (k, v) { return v; }) + '\n';
    try { this.input.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding)); } catch (e) {
      this.stop(); this.start(); this.input.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding));
    }
    var deadline = Date.now() + CALL_TIMEOUT_S * 1000;
    while (!this.replies.length) {
      pump(0.05);
      serveWhileBusy();
      if (CURRENT && CANCELLED[CURRENT.key]) { this.stop(); throw new Cancelled(); }
      if (this.dead) { this.stop(); return { died: true }; }
      if (Date.now() > deadline) { this.stop(); return { timeout: true }; }
    }
    return this.replies.shift();
  }
};
// Run one action here and report it as data (used by the worker, or in-process without one).
function runAction(name, rawArgs) {
  NOTES = [];
  try {
    var spec = ACTIONS[name];
    var a = normaliseArgs(rawArgs, spec.args, 'args', spec.tool === 'write');
    var value = spec.run(a);
    return { value: value, notes: NOTES.slice() };
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    return { notes: NOTES.slice(), error: e instanceof UserError ? { user: true, message: e.message, hint: e.hint }
      : { message: errorText(e), number: (e && e.errorNumber) || null } };
  }
}
function workerLoop() { // one JSON request per line on stdin, one reply per line on stdout
  var stdin = $.NSFileHandle.fileHandleWithStandardInput, bytes = $.NSMutableData.alloc.init, buf = '';
  while (true) {
    var chunk = stdin.availableData;
    if (!chunk || Number(chunk.length) === 0) break;
    bytes.appendData(chunk);
    var str = $.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding);
    if (!str || str.isNil()) continue; // a character split between chunks: wait for the rest
    buf += str.js; bytes = $.NSMutableData.alloc.init;
    var nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      var line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      var req = safe(function () { return JSON.parse(line); }, null), reply;
      if (!req || !ACTIONS[req.action]) reply = { error: { message: 'unknown worker request' } };
      else reply = runAction(req.action, req.args || {});
      send(reply);
    }
  }
}

// ---------- stdio with cancellation ----------
// stdin is read in the background (run loop notifications). While the worker runs a call, other requests
// (ping, tools/list, …) are answered right away and a cancellation of the running call stops the worker.
function Cancelled() {}
var QUEUE = [], CANCELLED = Object.create(null), CURRENT = null, EOF = false, STDIN_OBSERVER = null;
var inBuf = $.NSMutableData.alloc.init;
function idKey(id) { return typeof id + ':' + String(id); }
function isRequestId(id) { return typeof id === 'string' || (typeof id === 'number' && isFinite(id)); }
function onMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  var hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (typeof msg.method !== 'string' && hasId && ('result' in msg || 'error' in msg)) return; // a response to us: nothing to do
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || (hasId && !isRequestId(msg.id)))
    return send({ jsonrpc: '2.0', id: hasId && isRequestId(msg.id) ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } });
  if (!hasId) { // notification: never answered
    if (msg.method === 'notifications/cancelled' && msg.params && isRequestId(msg.params.requestId)) {
      var k = idKey(msg.params.requestId);
      // only ids that are queued or running, so a stale cancel can never hit a later request
      if ((CURRENT && CURRENT.key === k) || QUEUE.some(function (r) { return r.key === k; })) CANCELLED[k] = true;
    }
    return;
  }
  QUEUE.push({ key: idKey(msg.id), msg: msg });
}
function serveWhileBusy() { // answer everything but tool calls while a tool call runs
  for (var i = 0; i < QUEUE.length; i++) {
    var r = QUEUE[i];
    if (r.msg.method === 'tools/call') continue;
    QUEUE.splice(i--, 1);
    handle(r.msg);
  }
}
function onChunk(data) {
  inBuf.appendData(data);
  var str = $.NSString.alloc.initWithDataEncoding(inBuf, $.NSUTF8StringEncoding);
  if (!str || str.isNil()) return; // partial UTF-8 sequence, wait for more
  str = str.js;
  var nl = str.lastIndexOf('\n');
  if (nl < 0) return;
  var complete = str.slice(0, nl), rest = str.slice(nl + 1);
  inBuf = $.NSMutableData.alloc.init;
  if (rest.length) inBuf.appendData($(rest).dataUsingEncoding($.NSUTF8StringEncoding));
  complete.split('\n').forEach(function (line) {
    line = line.trim();
    if (!line) return;
    var msg;
    try { msg = JSON.parse(line); } catch (e) { log('bad json (' + line.length + ' chars)'); return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    onMessage(msg);
  });
}
ObjC.registerSubclass({ name: 'SeafileMCPStdin', methods: { 'onData:': { types: ['void', ['id']], implementation: function (n) {
  var d = n.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
  if (!d || Number(d.length) === 0) { EOF = true; return; } // NSData.length bridges as a string
  try { onChunk(d); } catch (e) { log('input error: ' + errorText(e)); }
  n.object.readInBackgroundAndNotify;
} } } });
ObjC.registerSubclass({ name: 'SeafileMCPWorkerOut', methods: { 'onData:': { types: ['void', ['id']], implementation: function (n) {
  if (Worker.onData(n.userInfo.objectForKey($.NSFileHandleNotificationDataItem))) n.object.readInBackgroundAndNotify;
} } } });
function pump(seconds) { $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(seconds)); }
function checkCancelled() {
  if (WORKER_MODE) return; // the main process stops the worker instead
  pump(0);
  if (CURRENT && CANCELLED[CURRENT.key]) throw new Cancelled();
}
function run() {
  ObjC.import('signal');
  $.signal(13, 1); // SIGPIPE ignored: writing to a closed pipe throws instead of killing the process
  if (WORKER_MODE) return workerLoop();
  var stdin = $.NSFileHandle.fileHandleWithStandardInput;
  STDIN_OBSERVER = $.SeafileMCPStdin.alloc.init; // kept: the notification center does not retain observers
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(STDIN_OBSERVER, 'onData:', $.NSFileHandleReadCompletionNotification, stdin);
  stdin.readInBackgroundAndNotify;
  log('started ' + VERSION + (READ_ONLY ? ' (read-only)' : '') + ', timeout ' + CALL_TIMEOUT_S + ' s' + (Worker.usable() ? '' : ', no worker'));
  while (true) {
    if (!QUEUE.length) { if (EOF) break; pump(60); continue; }
    pump(0); // cancellations that arrived while the previous request ran
    var r = QUEUE.shift();
    if (CANCELLED[r.key]) { delete CANCELLED[r.key]; log('skipped cancelled request ' + r.msg.id); continue; }
    CURRENT = r;
    try { handle(r.msg); } finally { delete CANCELLED[r.key]; CURRENT = null; }
  }
  Worker.stop();
  log('stdin closed, exiting');
}
