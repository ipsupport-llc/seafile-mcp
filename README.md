<p align="center">
  <img src="icon.png" width="96" alt="">
</p>

<h1 align="center">Seafile MCP</h1>

<p align="center">
  Let your AI assistant browse, search, read and organize the files in your Seafile —<br>
  with a browser sign-in, from any MCP client on a Mac. No dependencies.
</p>

<p align="center">
  <a href="../../releases/latest"><b>Download the latest release</b></a> ·
  <a href="#install">Install</a> ·
  <a href="#what-it-can-do">What it can do</a> ·
  <a href="#safety">Safety</a>
</p>

---

## Why this exists

[Seafile](https://www.seafile.com) is a self-hosted file sync and share server. This [MCP](https://modelcontextprotocol.io) server lets an assistant work with it the way a connector would:

- **Browser sign-in.** The first time, a browser window opens on your Seafile's own login page — password, SSO or two-factor, whatever your server uses. The assistant never sees your password; the token goes into the macOS Keychain.
- **Any MCP client.** Desktop chat apps, local-model apps, coding agents — anything that starts an MCP server over stdio.
- **Nothing to install.** No Node, no Python, no Homebrew: it runs on JavaScript for Automation with the Mac's own `curl` and Keychain.
- **Two permission prompts, not thirty.** Everything is grouped into a `read` tool and a `write` tool.
- **Works with small local models too.** Arguments are forgiving (`repo` for `library`, `folder` for `path`, `"true"`, short action names like `ls`, `mv`, `rm`), and every mistake comes back with a plain "how to fix".

## What it can do

| | |
| --- | --- |
| **Browse** | Libraries (yours, shared, group), folders, file details. |
| **Search** | Files and folders by name, in one library or all. |
| **Read** | The text of text files (Markdown, CSV, code, logs…), paged for long ones. |
| **Versions & trash** | A file's history, bring back an old version, list and restore deleted items. |
| **Files** | Download into your local folder, upload from it, write a text file. |
| **Organize** | Create folders, rename, move and copy (also between libraries), delete to the library trash. |
| **Share** | Create share links (password, expiry, download/upload), list and remove them. |

## Install

You need macOS 14 or later and an MCP client.

### Any MCP client

Get the code (`git clone`, or unzip the `.mcpb` from the [latest release](../../releases/latest)) and add the server to your client's config:

```json
{
  "mcpServers": {
    "seafile": {
      "command": "/usr/bin/osascript",
      "args": ["-l", "JavaScript", "/path/to/seafile-mcp/server/seafile-mcp.js"],
      "env": { "SEAFILE_URL": "https://cloud.example.com" }
    }
  }
}
```

`./install.sh --print --server https://cloud.example.com` prints this block with the right path.

### Claude Desktop (one click)

Download **`seafile-mcp.mcpb`** from the [latest release](../../releases/latest), double-click it and click **Install**. Settings live in **Settings → Extensions**.

### Settings

| Variable | What it does |
| --- | --- |
| `SEAFILE_URL` | Your server, e.g. `https://cloud.example.com`. If empty, tell the assistant at the first sign-in; it is remembered. |
| `SEAFILE_LOCAL_DIR` | The only local folder files are downloaded to and uploaded from. Default `~/Downloads`. |
| `SEAFILE_READ_ONLY=true` | Removes the `write` tool entirely. |
| `SEAFILE_TIMEOUT` | Seconds one call may take before it is stopped (default 60). |

The server must allow browser sign-in for clients (`CLIENT_SSO_VIA_LOCAL_BROWSER = True` in `seahub_settings.py`, as the Seafile desktop client uses).

## Safety

- **Deletes go to the library trash** and can be restored — and the server refuses to delete in a library that keeps no history (where deleted items would be gone).
- **Nothing is overwritten by surprise.** Uploading or writing over an existing file needs `replace: true`, and the old one stays in the file history. Downloads never overwrite local files.
- **One local folder.** Uploads come only from, and downloads go only to, the local folder in the settings — a prompt-injected "upload ~/.ssh/id_rsa" is refused.
- **Dry runs** for upload, write, move, copy, delete and share links.
- **No accidental repeats.** The same write twice within 15 minutes is refused unless asked again on purpose.
- **Nothing hangs.** A call that takes too long is stopped with a clear error; ping and tools/list always answer.
- **Watch out for instructions hidden in files.** Anything the assistant reads becomes part of its context. Keep `write` on manual approval, or turn on read-only mode.
- **One readable file.** The whole server is [`server/seafile-mcp.js`](server/seafile-mcp.js).

Encrypted libraries can be listed, but not read, uploaded to or shared here — use the Seafile web page or desktop client for those.

<details>
<summary><b>Tool reference</b></summary>

Two tools, each taking `{ "action": "...", "args": { ... } }`; the full argument list is in each tool's description. Paths start at the library root (`/Projects/report.pdf`); libraries are given by name or id.

**`read`**: `sign_in` · `status` · `list_libraries` · `list_folder` · `search` · `file_info` · `read_file` · `file_history` · `list_trash` · `list_share_links`

**`write`**: `download_file` · `upload_file` · `write_text_file` · `create_folder` · `rename` · `move` · `copy` · `delete` · `restore` · `revert_file` · `create_share_link` · `delete_share_link` · `sign_out`
</details>

<details>
<summary><b>Development</b></summary>

```sh
/usr/bin/osascript -l JavaScript tests/unit.js server/seafile-mcp.js   # fake Seafile, fake Keychain
python3 tests/protocol.py                                              # JSON-RPC, worker, installer
./test.sh                                                              # real server: signs in, lists libraries
```

Push a tag (`git tag v0.1.0 && git push origin v0.1.0`) and GitHub Actions runs the tests, builds the `.mcpb`, attaches it to a release and lists it in the MCP Registry.
</details>

## License

MIT © IPSupport LLC
