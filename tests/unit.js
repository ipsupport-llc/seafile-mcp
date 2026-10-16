// Unit tests: load the server with a fake Seafile, a fake Keychain and a fake browser, and call its actions directly.
// Run:  /usr/bin/osascript -l JavaScript tests/unit.js server/seafile-mcp.js
// Nothing here touches the network or the real Keychain.

ObjC.import('Foundation');

var SERVER_URL = 'https://files.example.com';
function makeFake() {
  var F = { libs: {}, links: [], tokens: { good: 'alice@example.com' }, sso: {}, opened: [], calls: [], secrets: {}, nextSso: 1, uploads: [] };
  function lib(id, name, o) {
    F.libs[id] = { id: id, name: name, type: o.type || 'mine', permission: o.permission || 'rw', encrypted: !!o.encrypted, keep_days: o.keep_days == null ? 30 : o.keep_days,
      owner: o.owner || 'alice@example.com', items: o.items || {}, trash: [] };
  }
  lib('11111111-1111-1111-1111-111111111111', 'Projects', { items: {
    '/2026': { type: 'dir' }, '/2026/plan.md': { type: 'file', content: '# Plan\nship it' }, '/2026/logo.png': { type: 'file', content: 'PNG\u0000\u0001binary' },
    '/Archive': { type: 'dir' }, '/notes.txt': { type: 'file', content: 'hello' } } });
  lib('22222222-2222-2222-2222-222222222222', 'Shared Docs', { type: 'shared', permission: 'r', owner: 'bob@example.com', items: { '/readme.txt': { type: 'file', content: 'read me' } } });
  lib('33333333-3333-3333-3333-333333333333', 'Scratch', { keep_days: 0, items: { '/tmp.txt': { type: 'file', content: 'x' } } });
  lib('44444444-4444-4444-4444-444444444444', 'Vault', { encrypted: true, items: { '/secret.txt': { type: 'file', content: 's' } } });
  lib('55555555-5555-5555-5555-555555555555', 'Projects', { type: 'shared', permission: 'rw', owner: 'carol@example.com', items: {} });
  F.lib = function (name) { return Object.keys(F.libs).map(function (k) { return F.libs[k]; }).filter(function (l) { return l.name === name; })[0]; };
  return F;
}
function parse(url) {
  var m = /^(https?:\/\/[^\/]+)(\/[^?]*)(?:\?(.*))?$/.exec(url), q = {};
  (m[3] || '').split('&').filter(Boolean).forEach(function (kv) { var p = kv.split('='); var k = decodeURIComponent(p[0]), v = decodeURIComponent(p[1] || ''); q[k] = q[k] === undefined ? v : [].concat(q[k], v); });
  return { origin: m[1], path: m[2], q: q };
}
function ok(json) { return { status: 200, json: json, text: JSON.stringify(json) }; }
function err(status, msg) { return { status: status, json: { error_msg: msg }, text: JSON.stringify({ error_msg: msg }) }; }
function fakeHttp(F) {
  return function (req) {
    F.calls.push((req.method || 'GET') + ' ' + req.url);
    if (F.offline) return { status: 0, curl: 6, text: 'Could not resolve host' };
    var u = parse(req.url), m = req.method || 'GET', path = u.path;
    if (u.origin !== SERVER_URL && !/^\/seafhttp\//.test(path)) return { status: 0, curl: 6, text: 'Could not resolve host' };
    if (path === '/api2/client-sso-link/' && m === 'POST') { var t = 'sso' + (F.nextSso++); F.sso[t] = 'waiting'; return ok({ link: SERVER_URL + '/client-sso/' + t + '/' }); }
    var sso = /^\/api2\/client-sso-link\/([^\/]+)\/$/.exec(path);
    if (sso) { var st = F.sso[sso[1]]; if (!st) return { status: 404, text: '' }; return ok(st === 'done' ? { status: 'success', username: 'alice@example.com', apiToken: 'good' } : { status: st }); }
    if (/^\/seafhttp\/files\//.test(path)) {
      var f = F.download[path]; if (!f) return { status: 404, text: 'not found' };
      if (req.out) { $(f.content).writeToFileAtomicallyEncodingError(req.out, true, $.NSUTF8StringEncoding, $()); return { status: 200, text: '', saved: req.out }; }
      return { status: 200, text: f.content };
    }
    if (/^\/seafhttp\/(upload|update)-api\//.test(path)) {
      var parts = {}; (req.multipart || []).forEach(function (p) { parts[p.name] = p.file ? ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(p.file, $.NSUTF8StringEncoding, $())) : p.value; });
      var lb = F.libs[F.uploadLib], name = (req.multipart.filter(function (p) { return p.name === 'file'; })[0].file || '').split('/').pop();
      var target = parts.target_file || ((parts.parent_dir === '/' ? '' : parts.parent_dir) + '/' + name);
      lb.items[target] = { type: 'file', content: parts.file }; F.uploads.push(target);
      return ok([{ name: name, id: 'x', size: String(parts.file).length }]);
    }
    var auth = (req.headers || {}).Authorization || '', user = F.tokens[auth.replace(/^Token /, '')];
    if (!user) return { status: 401, json: { detail: 'Invalid token' }, text: '{"detail":"Invalid token"}' };
    if (path === '/api2/account/info/') return ok({ email: user, name: 'Alice', total: 1000, usage: 10, space_usage: '1%' });
    if (path === '/api/v2.1/repos/') return ok({ repos: Object.keys(F.libs).map(function (k) { var l = F.libs[k]; return { type: l.type, repo_id: l.id, repo_name: l.name, size: 1, encrypted: l.encrypted, permission: l.permission, owner_email: l.owner, last_modified: '2026-10-01T00:00:00Z' }; }) });
    var r = /^\/api(?:2|\/v2\.1)\/repos\/([0-9a-f-]{36})\/(.*)$/.exec(path), L = r && F.libs[r[1]], rest = r && r[2];
    if (r && !L) return err(404, 'Library not found.');
    function children(dir) { return Object.keys(L.items).filter(function (p) { var par = p.slice(0, p.lastIndexOf('/')) || '/'; return par === dir; }); }
    if (rest === 'dir/' && m === 'GET') {
      var dir = u.q.p || '/'; if (dir !== '/' && !(L.items[dir] && L.items[dir].type === 'dir')) return err(404, 'Folder ' + dir + ' not found.');
      return ok({ dirent_list: children(dir).map(function (p) { var it = L.items[p]; return { type: it.type, name: p.split('/').pop(), size: it.type === 'file' ? String(it.content).length : undefined, mtime: 1760000000, modifier_name: 'Alice' }; }) });
    }
    if (rest === 'dir/' && m === 'POST') { L.items[u.q.p] = { type: 'dir' }; var pp = u.q.p.split('/'); for (var i = 2; i < pp.length; i++) { var pr = pp.slice(0, i).join('/'); if (!L.items[pr]) L.items[pr] = { type: 'dir' }; } return { status: 201, text: '"success"', json: 'success' }; }
    if (rest === 'file/detail/') { var fd = L.items[u.q.p]; return fd ? ok({ size: String(fd.content).length, mtime: 1760000000, last_modifier_name: 'Alice', can_edit: true }) : err(404, 'File not found'); }
    if (rest === 'file/' && m === 'GET') { var fl = L.items[u.q.p]; if (!fl) return err(404, 'File not found'); F.download = F.download || {}; var key = '/seafhttp/files/t' + Math.random() + '/' + u.q.p.split('/').pop(); F.download[key] = fl; return { status: 200, json: SERVER_URL + key, text: JSON.stringify(SERVER_URL + key) }; }
    if ((rest === 'file/' || rest === 'dir/') && m === 'POST' && req.form && req.form.operation === 'rename') {
      var old = u.q.p, np = (old.slice(0, old.lastIndexOf('/')) || '') + '/' + req.form.newname; L.items[np] = L.items[old]; delete L.items[old]; return ok({ obj_name: req.form.newname });
    }
    if (rest === 'upload-link/' || rest === 'update-link/') { F.uploadLib = L.id; return { status: 200, json: SERVER_URL + '/seafhttp/' + (rest === 'upload-link/' ? 'upload' : 'update') + '-api/tok', text: '' }; }
    if (rest === 'history-limit/') return L.owner === 'alice@example.com' ? ok({ keep_days: L.keep_days }) : err(403, 'Permission denied.');
    if (rest === 'trash2/') return ok({ items: [], total_count: 0, can_search: L.keep_days !== 0 });
    if (rest === 'trash/') return ok({ data: L.trash, more: false });
    if (rest === 'trash/revert-dirents/') { var tp = [].concat(req.form.path)[0], te = L.trash.filter(function (x) { return x.full === tp; })[0]; L.items[tp] = te.item; L.trash = L.trash.filter(function (x) { return x !== te; }); return ok({ success: [{ path: tp }], failed: [] }); }
    if (rest === 'file/history/') return ok({ data: [{ commit_id: 'c1', ctime: '2026-10-01T00:00:00Z', size: 3, creator_email: user, description: 'Modified' }] });
    if (rest === 'file/revert/') return ok({ success: true });
    if (path === '/api/v2.1/repos/batch-delete-item/') {
      var B = F.libs[req.json.repo_id]; req.json.dirents.forEach(function (n) { var full = (req.json.parent_dir === '/' ? '' : req.json.parent_dir) + '/' + n;
        B.trash.push({ parent_dir: req.json.parent_dir, obj_name: n, full: full, is_dir: B.items[full].type === 'dir', commit_id: 'del1', deleted_time: 'now', item: B.items[full] }); delete B.items[full]; });
      return ok({ success: true });
    }
    var mv = /^\/api\/v2\.1\/repos\/sync-batch-(move|copy)-item\/$/.exec(path);
    if (mv) { var src = F.libs[req.json.src_repo_id], dst = F.libs[req.json.dst_repo_id]; req.json.src_dirents.forEach(function (n) {
        var from = (req.json.src_parent_dir === '/' ? '' : req.json.src_parent_dir) + '/' + n, to = (req.json.dst_parent_dir === '/' ? '' : req.json.dst_parent_dir) + '/' + n;
        dst.items[to] = src.items[from]; if (mv[1] === 'move') delete src.items[from]; }); return ok({ success: true }); }
    if (path === '/api/v2.1/search-file/') { var SL = F.libs[u.q.repo_id]; return ok({ data: Object.keys(SL.items).filter(function (p) { return p.toLowerCase().indexOf(u.q.q.toLowerCase()) >= 0; }).map(function (p) { return { path: p, type: SL.items[p].type === 'dir' ? 'folder' : 'file', size: 1, mtime: '2026-10-01' }; }) }); }
    if (path === '/api/v2.1/share-links/' && m === 'GET') return ok(F.links);
    if (path === '/api/v2.1/share-links/' && m === 'POST') { var lk = { token: 'abc' + F.links.length, link: SERVER_URL + '/d/abc' + F.links.length + '/', path: req.form.path, repo_id: req.form.repo_id, is_dir: false, expire_date: '', permissions: JSON.parse(req.form.permissions), password: req.form.password || '' }; F.links.push(lk); return ok(lk); }
    var dl = /^\/api\/v2\.1\/share-links\/([^\/]+)\/$/.exec(path);
    if (dl && m === 'DELETE') { F.links = F.links.filter(function (x) { return x.token !== dl[1]; }); return ok({ success: true }); }
    return err(500, 'fake: unhandled ' + m + ' ' + path);
  };
}

function readFile(p) { return ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null)); }
function run(argv) {
  var src = readFile(argv[0] || 'server/seafile-mcp.js').replace(/\nfunction run\(\) \{/, '\nfunction serverRun() {')
    .replace("name: 'SeafileMCPStdin'", "name: 'SeafileMCPStdinT" + Date.now() + "'").replace("name: 'SeafileMCPWorkerOut'", "name: 'SeafileMCPWorkerOutT" + Date.now() + "'");
  (0, eval)(src);
  var LOCAL = ObjC.unwrap($.NSTemporaryDirectory()).replace(/\/$/, '') + '/seafile-mcp-test-' + Date.now();
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(LOCAL, true, $(), $());
  LOCAL = stdPath(LOCAL);
  var F, passed = 0, failed = [];
  function reset(signedIn) {
    F = makeFake();
    http = fakeHttp(F);
    secretGet = function (k) { return F.secrets[k] || null; };
    secretSet = function (k, v) { F.secrets[k] = v; };
    secretDelete = function (k) { delete F.secrets[k]; };
    openURL = function (u) { F.opened.push(u); };
    delay = function () {};
    SESSION = { server: null, token: null, user: null }; LIB_CACHE = { at: 0, list: null }; DONE = []; LAST_READ = { key: null, at: 0 };
    LOCAL_DIR = LOCAL;
    F.secrets[STATE_ACCOUNT] = SERVER_URL;
    if (signedIn !== false) F.secrets[SERVER_URL] = 'good';
  }
  function call(tool, input) { NOTES = []; return JSON.parse(formatResult(callPublic(tool, input))); }
  function callErr(tool, input) { NOTES = []; try { callPublic(tool, input); } catch (e) { return formatError(e); } throw new Error('expected an error from ' + JSON.stringify(input)); }
  function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b)); }
  function ok(v, msg) { if (!v) throw new Error(msg || 'expected true'); }
  function has(text, part) { if (String(text).indexOf(part) < 0) throw new Error('expected "' + part + '" in: ' + text); }
  function test(name, f) { reset(); try { f(); passed++; } catch (e) { failed.push(name + ': ' + (e && e.message ? e.message : e)); } }
  function local(name, text) { var p = LOCAL + '/' + name; $(text).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, $()); return p; }

  // ---- sign-in
  test('no server set: says how to set it', function () { delete F.secrets[STATE_ACCOUNT]; has(callErr('read', { action: 'status' }), 'No Seafile server is set'); });
  test('browser sign-in: opens a one-time link, then finishes on the next call', function () {
    delete F.secrets[SERVER_URL];
    has(callErr('read', { action: 'list_libraries' }), 'A browser window opened');
    eq(F.opened.length, 1); has(F.opened[0], '/client-sso/sso1/');
    has(callErr('read', { action: 'list_libraries' }), 'Waiting for the Seafile sign-in');
    eq(F.opened.length, 1, 'no second window while waiting');
    F.sso.sso1 = 'done';
    var r = call('read', { action: 'list_libraries' });
    ok(r.count >= 4); eq(F.secrets[SERVER_URL], 'good'); has(r.notes.join(' '), 'Signed in to ' + SERVER_URL + ' as alice@example.com');
  });
  test('an expired link starts over with a new window', function () {
    delete F.secrets[SERVER_URL]; callErr('read', { action: 'status' }); F.sso.sso1 = 'error';
    has(callErr('read', { action: 'status' }), 'A browser window opened'); eq(F.opened.length, 2);
  });
  test('a revoked token signs in again', function () {
    F.secrets[SERVER_URL] = 'revoked';
    has(callErr('read', { action: 'status' }), 'A browser window opened'); ok(!F.secrets[SERVER_URL]);
  });
  test('sign_in with a server address remembers it; no address is ever built in', function () {
    delete F.secrets[STATE_ACCOUNT]; delete F.secrets[SERVER_URL];
    has(callErr('read', { action: 'sign_in', args: { server: 'files.example.com' } }), 'browser window');
    eq(F.secrets[STATE_ACCOUNT], SERVER_URL);
  });
  test('offline: plain words', function () { F.offline = true; has(callErr('read', { action: 'status' }), 'could not be resolved'); });

  // ---- reading
  test('libraries and folders; names resolve case-insensitively; duplicates ask for the id', function () {
    eq(call('read', { action: 'list_folder', args: { library: 'shared docs' } }).items.map(function (x) { return x.name; }), ['readme.txt']);
    has(callErr('read', { action: 'list_folder', args: { library: 'Projects' } }), 'Several libraries are named "Projects"');
    var r = call('read', { action: 'ls', args: { repo: '11111111-1111-1111-1111-111111111111', folder: '2026/' } });
    eq(r.items.map(function (x) { return x.type + ':' + x.name; }), ['file:logo.png', 'file:plan.md']);
    has(callErr('read', { action: 'list_folder', args: { library: 'Projets' } }), 'Did you mean');
  });
  test('paths: .. refused, backslashes and missing slash fixed', function () {
    has(callErr('read', { action: 'file_info', args: { library: '11111111-1111-1111-1111-111111111111', path: '/2026/../../etc' } }), '".." is not allowed');
    eq(call('read', { action: 'file_info', args: { library: '11111111-1111-1111-1111-111111111111', path: '2026\\plan.md' } }).path, '/2026/plan.md');
  });
  test('read_file: text yes, binary no, paged', function () {
    var L = '11111111-1111-1111-1111-111111111111';
    eq(call('read', { action: 'read_file', args: { library: L, path: '/2026/plan.md' } }).text, '# Plan\nship it');
    has(callErr('read', { action: 'read_file', args: { library: L, path: '/2026/logo.png' } }), 'not a text file');
    has(callErr('read', { action: 'read_file', args: { library: 'Vault', path: '/secret.txt' } }), 'encrypted');
  });
  test('search goes through every library and says it matches names only', function () {
    var r = call('read', { action: 'search', args: { query: 'plan' } });
    eq(r.items.map(function (x) { return x.path; }), ['/2026/plan.md']); has(r.notes.join(' '), 'not the text inside');
  });

  // ---- writing
  test('upload only from the local folder; existing names need replace; dry_run', function () {
    var L = '11111111-1111-1111-1111-111111111111';
    has(callErr('write', { action: 'upload_file', args: { library: L, file: '~/.ssh/id_rsa' } }), 'only inside');
    var f = local('notes.txt', 'new text');
    has(callErr('write', { action: 'upload_file', args: { library: L, file: f } }), 'already exists');
    eq(call('write', { action: 'upload_file', args: { library: L, file: 'notes.txt', replace: true, dry_run: true } }).dry_run, true);
    eq(F.uploads.length, 0);
    call('write', { action: 'upload', args: { library: L, file: 'notes.txt', folder: '/Archive' } });
    eq(F.lib('Projects').items['/Archive/notes.txt'].content, 'new text');
  });
  test('download never overwrites and stays in the local folder', function () {
    var L = '11111111-1111-1111-1111-111111111111';
    var a = call('write', { action: 'download_file', args: { library: L, path: '/notes.txt' } }), b = call('write', { action: 'download_file', args: { library: L, path: '/notes.txt', repeat: true } });
    ok(a.saved !== b.saved, 'second copy got a new name'); ok(a.saved.indexOf(LOCAL + '/') === 0 && b.saved.indexOf(LOCAL + '/') === 0, 'inside the local folder');
    has(callErr('write', { action: 'download_file', args: { library: L, path: '/notes.txt', to: '/etc' } }), 'only inside');
  });
  test('write_text_file creates; replacing needs replace:true', function () {
    var L = '11111111-1111-1111-1111-111111111111';
    call('write', { action: 'write_text_file', args: { library: L, path: '/2026/todo.md', text: '- a' } });
    eq(F.lib('Projects').items['/2026/todo.md'].content, '- a');
    has(callErr('write', { action: 'write_text_file', args: { library: L, path: '/2026/todo.md', text: '- b' } }), 'already exists');
    call('write', { action: 'write_text_file', args: { library: L, path: '/2026/todo.md', text: '- b', replace: true } });
    eq(F.lib('Projects').items['/2026/todo.md'].content, '- b');
  });
  test('read-only library refuses writes', function () { has(callErr('write', { action: 'create_folder', args: { library: 'Shared Docs', path: '/x' } }), 'read-only'); });
  test('rename refuses a taken name and paths in new_name', function () {
    var L = '11111111-1111-1111-1111-111111111111';
    has(callErr('write', { action: 'rename', args: { library: L, path: '/notes.txt', new_name: '2026' } }), 'already exists');
    has(callErr('write', { action: 'rename', args: { library: L, path: '/notes.txt', new_name: 'a/b' } }), 'not a path');
    eq(call('write', { action: 'rename', args: { library: L, path: '/notes.txt', new_name: 'memo.txt' } }).to, '/memo.txt');
  });
  test('move: clashes, into itself, missing items; dry_run; across libraries', function () {
    var L = '11111111-1111-1111-1111-111111111111';
    has(callErr('write', { action: 'move', args: { library: L, paths: ['/2026'], to_folder: '/2026' } }), 'into itself');
    has(callErr('write', { action: 'move', args: { library: L, paths: ['/nope.txt'], to_folder: '/Archive' } }), 'Not found: /nope.txt');
    eq(call('write', { action: 'mv', args: { library: L, path: '/notes.txt', to: '/Archive', dry_run: true } }).dry_run, true);
    call('write', { action: 'move', args: { library: L, paths: ['/notes.txt'], to_folder: '/Archive' } });
    ok(F.lib('Projects').items['/Archive/notes.txt'] && !F.lib('Projects').items['/notes.txt']);
    has(callErr('write', { action: 'copy', args: { library: L, paths: ['/Archive/notes.txt'], to_folder: '/', to_library: 'Shared Docs' } }), 'read-only');
  });
  test('delete goes to trash only where history is kept; restore puts it back', function () {
    var L = '11111111-1111-1111-1111-111111111111';
    has(callErr('write', { action: 'delete', args: { library: 'Scratch', paths: ['/tmp.txt'] } }), 'keeps no history');
    has(callErr('write', { action: 'delete', args: { library: L, paths: ['/notes.txt', '/ghost.txt'] } }), 'Nothing was deleted');
    ok(F.lib('Projects').items['/notes.txt'], 'nothing deleted when one path is wrong');
    var r = call('write', { action: 'rm', args: { library: L, paths: '/notes.txt' } });
    eq(r.moved_to_trash, ['/notes.txt']); ok(!F.lib('Projects').items['/notes.txt']);
    eq(call('read', { action: 'list_trash', args: { library: L } }).items[0].path, '/notes.txt');
    call('write', { action: 'restore', args: { library: L, path: '/notes.txt' } });
    ok(F.lib('Projects').items['/notes.txt'], 'restored');
  });
  test('the same delete twice is refused', function () {
    var L = '11111111-1111-1111-1111-111111111111';
    call('write', { action: 'create_folder', args: { library: L, path: '/tmp1' } });
    has(callErr('write', { action: 'create_folder', args: { library: L, path: '/tmp1' } }), 'already succeeded');
  });
  test('share links: dry_run, create, encrypted refused, delete by link', function () {
    var L = '11111111-1111-1111-1111-111111111111';
    eq(call('write', { action: 'share', args: { library: L, path: '/notes.txt', dry_run: true } }).dry_run, true);
    eq(F.links.length, 0);
    var s = call('write', { action: 'create_share_link', args: { library: L, path: '/notes.txt', expire_days: 7 } });
    has(s.link, '/d/abc0/'); has(s.notes.join(' '), 'Anyone with this link');
    has(callErr('write', { action: 'create_share_link', args: { library: 'Vault', path: '/secret.txt' } }), 'encrypted');
    call('write', { action: 'delete_share_link', args: { link: s.link } });
    eq(F.links.length, 0);
  });
  test('write args are strict, read args lenient', function () {
    has(callErr('write', { action: 'create_folder', args: { library: 'Scratch', path: '/x', colour: 'red' } }), 'Unknown argument "colour"');
    has(call('read', { action: 'status', args: { colour: 'red' } }).notes.join(' '), 'ignored');
  });
  test('tool text is compact, English, every action listed', function () {
    PUBLIC_TOOLS.forEach(function (t) { ok(!/[А-Яа-яЁё]/.test(t.description)); actionsOf(t.name).forEach(function (n) { has(t.description, '• ' + n + '('); }); });
    ok(JSON.stringify(PUBLIC_TOOLS).length < 7000, 'catalog ' + JSON.stringify(PUBLIC_TOOLS).length);
    Object.keys(ACTION_ALIASES).forEach(function (k) { ok(ACTIONS[ACTION_ALIASES[k]], 'alias ' + k); });
  });

  var report = passed + ' passed, ' + failed.length + ' failed' + (failed.length ? '\n  ' + failed.join('\n  ') : '');
  $.NSFileManager.defaultManager.removeItemAtPathError(LOCAL, $());
  if (failed.length) throw new Error(report);
  return report;
}
