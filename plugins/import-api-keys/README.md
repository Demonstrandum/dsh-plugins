# import-api-keys

`/import-api-keys` — import provider API keys from a file on the machine you are
sitting at into the DSH you are talking to. A **browser command** (a
`ui-commands` contribution of kind `action`): picking it in the slash menu or
pressing Enter on the bare line opens the native file picker and never produces
a chat message or a session record. Because it is just the page, it behaves
identically in the local app, inside a hybrid remote frame, and in a
direct-remote (blue) Dock app — the three places a colleague's keys need to
reach a server they did not type them into.

## Flow

1. Native file picker (`<input type=file>`), `.json` / `.env` / text.
2. Parse in the browser (`parse.mjs`, sniffed by content, not filename):
   - **pi's `~/.pi/agent/auth.json`** — `{ "<provider>": { "type": "api_key", "key" } | { "type": "oauth", … } }`.
     Provider ids map to DSH credential refs through pi-ai's own env table
     (`@earendil-works/pi-ai` `env-api-keys`, e.g. `anthropic → ANTHROPIC_API_KEY`,
     `google → GEMINI_API_KEY`, `zai-coding-cn → ZAI_CODING_CN_API_KEY`) — the
     same names DSH's `llm-pi-ai` providers read as `apiKeyEnv`, so nothing else
     needs configuring. OAuth entries and unknown providers are listed as skipped.
   - a flat `{ "OPENAI_API_KEY": "…" }` map (ref grammar `[A-Z][A-Z0-9_]*`);
   - dotenv text (`export` allowed, quotes stripped, `#` comments);
   - **another DSH's `~/.dsh/.credentials.yaml`** — the `refs:` block is the key
     map (this is the file the command writes into on the receiving DSH, so
     "copy my local keys to the remote" is: pick this file). `records:` are
     reported: `llm-pi-ai/<provider>` `api-key` records import through the
     provider's env name; `grant` records (OAuth logins, e.g. Anthropic via
     `/login`) are skipped — there is no wire path for records, sign in on the
     other DSH; the browser-session grant is ignored. Read by a purpose-built
     parser of that file's fixed layout, not a YAML library.
3. `POST /import-api-keys/plan` (host half): each candidate is compared with the
   credential store and comes back as `new` · `same` · `different` ·
   `readonly` (supplied by the process environment — a write would not take) ·
   `invalid`. This round trip exists because DSH's wire API never returns a
   stored value (`describe` says configured-or-not only), so only the host can
   say whether an import **would overwrite a different value**.
4. Confirm modal — one table, `tick | name | summary`: new keys pre-ticked;
   keys whose stored value differs unticked but tickable ("tick to
   overwrite"); keys already stored with the same value have no box; invalid,
   read-only and skipped rows (OAuth logins, unknown pi providers) have a
   disabled box with the reason. *Import N* counts the ticks and is disabled
   when nothing is ticked.
5. Writes go through `ctx.remote.credentials.set` per key — DSH's sanctioned
   write path — then a done modal with what was stored and what failed.
   Providers re-resolve credentials per request, so imported keys work at once;
   no restart.

**Where the picker opens.** A web page cannot choose the picker's start
directory or pre-select a file. The DSH Dock apps are our own WKWebView
wrapper, so the plugin posts a one-shot hint to the wrapper's script-message
handler (`dshDock` → `{type: 'open-panel', file: '~/.pi/agent/auth.json',
directory: '~/.pi/agent', showsHiddenFiles: true, message}`) just before
opening the input; the wrapper applies it to the next `NSOpenPanel`: `auth.json`
**pre-selected** when it exists (AppKit selects the file when `directoryURL`
names a file — undocumented but long-standing), else the directory, hidden
files shown, a prompt line. In Safari/Chrome the hint is a no-op and the
picker opens wherever the browser last was; type `⇧⌘G` and `~/.pi/agent` there.

Values cross the wire twice (plan, set), over the admitted connection, and are
never written to the attachment store or to disk by the browser. An unreadable
or unrecognised file gives an error modal with the parser's reason.

## Composition

Host half: `inject = ['webServer', 'connection', 'credentials']`; the plan route
uses DSH's own request gate (`connection.requestRejection`: Host/Origin fence +
browser-session cookie) with the Connection JSON envelope, so the
tailscale-remote proxy forwards it for any admitted device. Browser half:
`inject = ['slots', 'commandUi', 'connection', 'remote', 'remote.credentials']`;
the dialogs render through the `shell.overlay` slot with the shared `Modal`.

No config. Installed as a bundle by `tools/install-plugins.sh` (standard list).

```sh
pnpm install && pnpm build   # lib/client.js
pnpm test                    # parser + plan classification
```

Verified 2026-09-21 against a remote instance over the tailnet: pi auth.json →
New/Skipped(oauth) → stored; second pass → Unchanged + Will be replaced; a text
file → error modal.
