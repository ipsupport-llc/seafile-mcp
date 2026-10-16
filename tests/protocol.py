#!/usr/bin/env python3
"""Protocol tests: run the real server over stdio and check JSON-RPC / MCP behaviour.

Run:  python3 tests/protocol.py
Only protocol paths are exercised; no request here reaches a Seafile server.
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server", "seafile-mcp.js")
failures = []


def run(lines, env=None, timeout=20):
    """Feed lines (str or dict), close stdin, return (responses, seconds). Fails if the server does not exit."""
    data = "".join((l if isinstance(l, str) else json.dumps(l)) + "\n" for l in lines)
    t = time.time()
    try:
        p = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", SERVER], input=data.encode(), capture_output=True,
                           timeout=timeout, env=dict(os.environ, **(env or {})))
        stdout = p.stdout
    except subprocess.TimeoutExpired as e:  # the server did not exit after stdin closed
        failures.append(f"server did not exit within {timeout}s after EOF")
        stdout = e.stdout or b""
    out = [json.loads(l) for l in stdout.decode().splitlines() if l.strip()]
    return out, time.time() - t


def by_id(out, i):
    return [r for r in out if r.get("id") == i]


def check(name, cond, detail=""):
    if not cond:
        failures.append(f"{name} {detail}")


INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}

# initialize negotiates; unknown versions get the newest supported one
out, secs = run([INIT, {"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "not-a-version"}}])
check("initialize echoes a supported version", by_id(out, 1)[0]["result"]["protocolVersion"] == "2025-06-18")
check("initialize falls back to a supported version", by_id(out, 2)[0]["result"]["protocolVersion"] != "not-a-version")
check("initialize has instructions", "instructions" in by_id(out, 1)[0]["result"])
check("exits on EOF", secs < 15, f"took {secs:.1f}s")

# notifications are never answered; responses are ignored
out, _ = run([INIT, {"jsonrpc": "2.0", "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"},
              {"jsonrpc": "2.0", "id": 99, "result": {}}, {"jsonrpc": "2.0", "id": 3, "method": "ping"}])
check("notifications get no response", [r.get("id") for r in out] == [1, 3], str(out))

# malformed input: errors, and the server keeps serving
out, _ = run(["{not json", "null", "[1,2]", '{"jsonrpc":"2.0","id":{"x":1},"method":"ping"}',
              {"jsonrpc": "2.0", "id": "toString", "method": "ping"}, {"jsonrpc": "2.0", "id": 7, "method": "ping"}])
codes = [r.get("error", {}).get("code") for r in out if "error" in r]
check("parse error -32700", -32700 in codes, str(out))
check("invalid request -32600", codes.count(-32600) == 3, str(codes))
check("id 'toString' is served", by_id(out, "toString") and "result" in by_id(out, "toString")[0], str(out))
check("still serving after bad input", by_id(out, 7) and "result" in by_id(out, 7)[0])

# unknown method
out, _ = run([{"jsonrpc": "2.0", "id": 4, "method": "nope"}])
check("unknown method -32601", out and out[0].get("error", {}).get("code") == -32601)

# a request cancelled before it starts is never run or answered; a stale cancel does not hit a later request
out, _ = run([INIT, {"jsonrpc": "2.0", "id": 5, "method": "tools/list"},
              {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "read", "arguments": {"action": "delete"}}},
              {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 6}},
              {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 8}},
              {"jsonrpc": "2.0", "id": 8, "method": "ping"}])
check("cancelled queued request gets no response", not by_id(out, 6), str(out))
check("stale cancel does not drop a later request", by_id(out, 8), str(out))

# tool errors are isError results with a hint, not JSON-RPC errors
out, _ = run([INIT, {"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "read", "arguments": {"action": "delete", "args": {}}}}])
r = by_id(out, 9)[0]["result"]
check("write action via read is an isError result", r.get("isError") and "write tool" in r["content"][0]["text"], str(r))

# tools/list: two tools with RIGHT/WRONG examples; read-only mode hides write and refuses it
out, _ = run([INIT, {"jsonrpc": "2.0", "id": 10, "method": "tools/list"}])
tools = by_id(out, 10)[0]["result"]["tools"]
check("two tools", [t["name"] for t in tools] == ["read", "write"])
check("description has RIGHT/WRONG", all("RIGHT:" in t["description"] and "WRONG:" in t["description"] for t in tools))
out, _ = run([INIT, {"jsonrpc": "2.0", "id": 11, "method": "tools/list"},
              {"jsonrpc": "2.0", "id": 12, "method": "tools/call", "params": {"name": "write", "arguments": {"action": "delete", "args": {}}}}],
             env={"SEAFILE_READ_ONLY": "true"})
check("read-only hides write", [t["name"] for t in by_id(out, 11)[0]["result"]["tools"]] == ["read"])
check("read-only: write is an unknown tool", by_id(out, 12)[0].get("error", {}).get("code") == -32602 and "read-only" in by_id(out, 12)[0]["error"]["message"])

# bad tools/call shapes are protocol errors (-32602); action mistakes are isError results
out, _ = run([INIT, {"jsonrpc": "2.0", "id": 13, "method": "tools/call", "params": {"name": "nope", "arguments": {}}},
              {"jsonrpc": "2.0", "id": 14, "method": "tools/call", "params": {"arguments": {}}},
              {"jsonrpc": "2.0", "id": 15, "method": "tools/call", "params": {"name": "read", "arguments": [1]}},
              {"jsonrpc": "2.0", "id": 16, "method": "tools/call", "params": {"name": "read", "arguments": {"action": "fly"}}}])
check("unknown tool -32602", by_id(out, 13)[0].get("error", {}).get("code") == -32602)
check("missing tool name -32602", by_id(out, 14)[0].get("error", {}).get("code") == -32602)
check("non-object arguments -32602", by_id(out, 15)[0].get("error", {}).get("code") == -32602)
check("unknown action is an isError result", by_id(out, 16)[0]["result"].get("isError"))

# stdin from a regular file (not a pipe) also ends cleanly
path = os.path.join(os.environ.get("TMPDIR", "/tmp"), "seafile-mcp-proto.jsonl")
with open(path, "w") as f:
    f.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}) + "\n")
t = time.time()
with open(path) as f:
    try:
        p = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", SERVER], stdin=f, capture_output=True, timeout=20)
        check("exits when stdin is a file", b'"id":1' in p.stdout)
    except subprocess.TimeoutExpired:
        check("exits when stdin is a file", False, "timed out")
os.remove(path)


# worker process: ping answers while a call runs, a stuck call times out, a running call can be cancelled
import select
import threading


def live(env):
    """Start the server; returns (send(obj), wait(id, seconds) -> (reply, seconds), close())."""
    proc = subprocess.Popen(["/usr/bin/osascript", "-l", "JavaScript", SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=dict(os.environ, **env))
    got, t0 = {}, time.time()

    def reader():
        for line in proc.stdout:
            if line.strip():
                r = json.loads(line)
                got[r.get("id")] = (r, time.time() - t0)
    threading.Thread(target=reader, daemon=True).start()

    def send(obj):
        proc.stdin.write((json.dumps(obj) + "\n").encode()); proc.stdin.flush()

    def wait(i, seconds):
        end = time.time() + seconds
        while time.time() < end and i not in got:
            time.sleep(0.05)
        return got.get(i, (None, None))

    def close():
        proc.stdin.close()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill(); failures.append("server with worker did not exit on EOF")
        return proc.stderr.read().decode()
    return send, wait, close, got


send, wait, close, got = live({"SEAFILE_TEST": "1", "SEAFILE_TIMEOUT": "3"})
send(INIT); wait(1, 20)
call = lambda i, secs: send({"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": "read", "arguments": {"action": "__sleep", "args": {"seconds": secs}}}})
call(20, 1)
r, _ = wait(20, 20)
check("worker runs a call", r and "slept" in r["result"]["content"][0]["text"], str(r))
t_start = time.time()
call(21, 30)
time.sleep(0.5)
send({"jsonrpc": "2.0", "id": 22, "method": "ping"})
r, at = wait(22, 5)
check("ping answers while a call runs", r is not None and "result" in r, str(r))
r, at = wait(21, 15)
check("stuck call times out with isError", r and r["result"].get("isError") and "did not answer within 3 s" in r["result"]["content"][0]["text"], str(r))
check("timeout comes on time", r is not None and time.time() - t_start < 8, f"{time.time() - t_start:.1f}s")
call(23, 1)
r, _ = wait(23, 20)
check("next call works after a timeout (new worker)", r and "slept" in r["result"]["content"][0]["text"], str(r))
call(24, 30)
time.sleep(1)
send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 24}})
send({"jsonrpc": "2.0", "id": 25, "method": "ping"})
wait(25, 5)
call(26, 1)
r, _ = wait(26, 20)
check("a cancelled running call gets no response", 24 not in got, str(got.get(24)))
check("calls work after a cancellation", r and "slept" in r["result"]["content"][0]["text"], str(r))
log = close()
check("stderr logs each call with app and time", "→ 20 read.__sleep [Test]" in log and "TIMEOUT" in log and "cancelled" in log, log[-600:])



# the worker joins a UTF-8 character split between two reads
w = subprocess.Popen(["/usr/bin/osascript", "-l", "JavaScript", SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                     env=dict(os.environ, SEAFILE_WORKER="1", SEAFILE_TEST="1"))
req = json.dumps({"action": "__sleep", "args": {"seconds": 0, "ключ": 1}}, ensure_ascii=False).encode() + b"\n"
cut = req.index("ключ".encode()) + 1  # in the middle of "к"
w.stdin.write(req[:cut]); w.stdin.flush(); time.sleep(0.5); w.stdin.write(req[cut:]); w.stdin.close()
reply = json.loads(w.stdout.readline() or b"{}"); w.wait(timeout=20)
check("worker handles a character split between reads", "ключ" in json.dumps(reply.get("notes", []), ensure_ascii=False), str(reply))

# install.sh / uninstall.sh against a throwaway HOME
import shutil
import tempfile
home = tempfile.mkdtemp()
cfg = os.path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")


def sh(*args):
    return subprocess.run([os.path.join(ROOT, args[0])] + list(args[1:]), capture_output=True, text=True, env=dict(os.environ, HOME=home), timeout=60)


def entry():
    with open(cfg) as f:
        return json.load(f)["mcpServers"]["seafile"]


os.makedirs(os.path.dirname(cfg))
with open(cfg, "w") as f:
    f.write("{}")  # plutil once read this as an OpenStep plist and wrote nothing
r = sh("install.sh", "--read-only", "--server", 'https://files.example.com/"x"')
check("install on a fresh {} config", r.returncode == 0 and entry()["env"] == {"SEAFILE_READ_ONLY": "true", "SEAFILE_URL": 'https://files.example.com/"x"'}, r.stdout + r.stderr)
sh("install.sh")
check("reinstall keeps settings", entry()["env"].get("SEAFILE_READ_ONLY") == "true")
sh("install.sh", "--no-read-only", "--server", "")
check("--no-read-only and --server '' clear them", entry()["env"] == {})
with open(cfg, "w") as f:
    json.dump({"other": 1, "mcpServers": {"x": {"command": "y"}}}, f)
sh("install.sh", "--local-dir", "/tmp/a b")
with open(cfg) as f:
    c = json.load(f)
check("other servers and keys are kept", c["other"] == 1 and "x" in c["mcpServers"] and c["mcpServers"]["seafile"]["env"] == {"SEAFILE_LOCAL_DIR": "/tmp/a b"})
r = sh("uninstall.sh")
with open(cfg) as f:
    c = json.load(f)
check("uninstall removes only seafile", "seafile" not in c["mcpServers"] and "x" in c["mcpServers"], r.stdout)
with open(cfg, "w") as f:
    f.write("not json")
r = sh("install.sh")
with open(cfg) as f:
    check("invalid config is refused and left alone", r.returncode != 0 and f.read() == "not json")
shutil.rmtree(home)

# real curl, local HTTP server: hostile file names stay one multipart part, ~/.curlrc is ignored
import http.server
import socketserver
import tempfile as _tf
got = []
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); got.append(self.rfile.read(n)); self.send_response(200); self.end_headers(); self.wfile.write(b"[]")
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", 0), H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
d = _tf.mkdtemp(); hostile = os.path.join(d, 'a,etc;type=x "q".txt')
with open(hostile, "w") as f: f.write("PAYLOAD")
home = _tf.mkdtemp()
with open(os.path.join(home, ".curlrc"), "w") as f: f.write('url = "http://127.0.0.1:%d/curlrc-extra"\n' % port)
jxa = os.path.join(d, "h.js")
with open(jxa, "w") as f:
    f.write("""ObjC.import('Foundation');
function run(argv) {
  var src = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null)).replace(/\\nfunction run\\(\\) \\{/, '\\nfunction serverRun() {');
  (0, eval)(src);
  var r = http({ method: 'POST', url: argv[1], multipart: [{ name: 'file', file: argv[2], filename: 'shown;name,"x".txt' }, { name: 'parent_dir', value: '/' }] });
  return String(r.status);
}""")
r = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", jxa, SERVER, "http://127.0.0.1:%d/upload" % port, hostile], capture_output=True, text=True, timeout=60, env=dict(os.environ, HOME=home))
body = got[0] if got else b""
check("real curl: request reached the local server", r.stdout.strip() == "200" and len(got) == 1, r.stdout + r.stderr + " requests=%d" % len(got))
check("real curl: one file part with the given name", body.count(b"PAYLOAD") == 1 and body.count(b'name="file"') == 1 and b'filename="shown;name,' in body, body[:400])
check("real curl: ~/.curlrc ignored", len(got) == 1)
srv.shutdown(); shutil.rmtree(d); shutil.rmtree(home)

if failures:
    print("FAILED:\n  " + "\n  ".join(failures))
    sys.exit(1)
print("protocol: all checks passed")
