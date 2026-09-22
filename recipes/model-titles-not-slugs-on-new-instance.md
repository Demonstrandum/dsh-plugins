# Model-generated session titles are not slugs on a new instance (DSH Remote)

**Date:** 2026-09-22. **Symptom:** in the DSH Remote sidebar, sessions the
model names come out as natural phrases ("Symba status and profiles i…",
"Checking for Symba toolset a…") while hand-typed `foo-bar: ` slugs work
(`symba-demo`, `<private>-plot-demo`). On this Mac's live DSH the same sessions
would be `symba-status-and-profiles`. **Nothing is broken**: the slug shape is
a *config override* that lives in `$DSH_HOME`, and the remote's home never got it.
(Host names, accounts and ports of the shared remote machine live only in the
private `extras/` submodule — `extras/AGENTS.md`, `extras/hosts/<host>.env`;
this public recipe uses `<remote>` / `<user>` placeholders.)

## The two mechanisms (do not confuse them)

| Titles | Where | Slug shape comes from |
|---|---|---|
| hand-typed `slug: prompt` | client plugin `plugins/session-title-slug` (`recipes/session-title-slug-plugin.md`) | the user typed it |
| model-generated | in-tree row `session-title-llm` (`@deepseek-ai/dsh-session-title-first-prompt-llm`) via the shared `packages/session/session-title-llm` | fork feature `style: slug` (commit `4cbd1113d8`, 2026-09-17; retry `22f438f2f2`): slug system prompt + `slugifyTitle()` coercion |

`style` is **not set in the base bundle** (`packages/bundle/base/cordis.patch.yml`
gives `session-title-llm` only `targetWords/targetCjkCharacters/maxInputBytes/
maxOutputTokens/timeoutMs`), so the default is `natural`. This Mac's
`~/.dsh/profiles/web/cordis.patch.yml` overrides the row:

```yaml
- id: session-title-llm
  config:                 # a patch row replaces the whole config — restate every key
    targetWords: 5
    targetCjkCharacters: 10
    maxInputBytes: 4096
    maxOutputTokens: 64
    timeoutMs: 60000
    style: slug
```

## Diagnosis trail

1. **Is the code there?** `git merge-base --is-ancestor 4cbd1113d8 HEAD` in the
   checkout that runs the instance. On the remote (`ssh <user>@<remote>`,
   checkout `~/github/tali-dash-plugins/deepseek-harness`) it was the same
   commit as here (`5029131621`) — present.
2. **Is the override there?** `grep -A9 session-title-llm
   ~/.dsh/profiles/web/cordis.patch.yml` — on the remote the profile patch holds
   only the `tali-tailscale-remote` row. Effective composition
   (`pnpm dsh --profile web --dump-config | grep -A8 'id: session-title-llm'`;
   `pnpm` is not on the non-interactive ssh PATH — prefix
   `export PATH=/opt/homebrew/bin:$PATH`) showed the bundle defaults and no
   `style`.
3. **What did the model actually write?** The `session/title` events in
   `$DSH_HOME/sessions/<ws>/<session>/session.v3.jsonl.zstd` carry
   `source.kind` (`fallback` | `provider` | `user`) and, for `provider`, the
   route. Locally: dozens of `"kind":"provider"` slug titles from
   `anthropic/claude-fable-5-1`. (The remote has no `zstd` on PATH and its
   `node` lacks `zlib.ZstdDecompress`, so `scp` the file here and `zstd -dc`.)
4. **Why the gap:** `tools/bootstrap-mac.sh` (what `pnpm bootstrap-remote` ran
   on the remote) writes only the `tali-tailscale-remote` row into the profile
   patch; the older `tools/deploy-remote.sh` overlay did include the slug row.
   `INSTALLING.md` lists the override as "optional, not a plugin".

## Verified in the preview (2026-09-22)

The preview home (`~/.dsh-preview`) had the same gap and reproduced the
symptom exactly (`"<private> plot command"`, `kind: provider`,
`apple/foundation`). Adding the override above to
`~/.dsh-preview/profiles/web/cordis.patch.yml` (kept), restarting the relay
(`launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview`,
then opening `https://…/dsh-preview/` — the relay starts DSH on demand) and
sending one prompt gave `session/title-llm-request` with the slug system
prompt and an accepted `explain-water` (`kind: provider`, Apple Foundation
parrots the prompt's example — the slug pipeline is what matters). Unit tests:
`pnpm exec vitest run packages/session/session-title-llm
packages/session/session-title-first-prompt-llm/tests/provider.spec.ts` from
the checkout root (16 pass; running vitest inside the package dir finds no
tests).

## Rolled out on the remote (2026-09-22, on the maintainer's request)

The shared remote machine runs **one DSH instance per macOS account** (seven at
the time; inventory and the `sync-host` tool are in the private extras —
`extras/AGENTS.md`), each with its own `~/github/tali-dash-plugins` clone,
`~/.dsh`, relay and Dock app (`ps -axo user,pid,command | grep 'bin.ts web'`
lists them all from any account; each account's `lsof` shows only its own
listeners). Per account, from this Mac:

```sh
ssh <user>@<remote> 'git -C ~/github/tali-dash-plugins pull --ff-only'
pnpm bootstrap-remote <user>@<remote> --only home   # from <plugins>; --dir defaults to ~/github/tali-dash-plugins
```

**No restart was needed.** `packages/boot/hmr/src/index.ts` watches the
profile patch under the `web` profile (`patchReload: live`) and runs
`reconcileProfilePatches` on change; a session started on one instance right
after the edit was titled `ls-command-explanation` by `anthropic/claude-haiku-4.5`
while the old sessions kept their natural titles (titles are never rewritten).
If a restart is ever wanted: `kill -TERM <that account's bin.ts web pid>` — the
relay respawns it, and open pages black-screen once unless `reload-on-restart`
is installed (`recipes/black-screen-after-server-restart.md`).

Done the same day: `tools/bootstrap-mac.sh` step `home` now sets the row
(idempotent; `grep style: slug` is the postcondition) through the new
`patch_set_row FILE ID JSON` helper, which the `tailnet` step also uses for
its `tali-tailscale-remote` row. The helper rewrites through the checkout's
`yaml` package because the fresh profile template ends in a literal `[]` — a
text append would be invalid YAML — and keeps only the file's leading `#`
header. On an existing install: `tools/bootstrap-mac.sh --only home --yes`
(no preflight gate, `DIR` defaults to `~/github/tali-dash-plugins`), then
restart `dsh web`.

## Troubleshooting

| Symptom | Meaning |
|---|---|
| provider titles natural, `style` absent in `--dump-config` | the profile patch lacks the override (this recipe) |
| titles are the first prompt truncated, `kind: fallback` only | the LLM provider never returned: check the route (`session/title-llm-request` event), `.credentials.yaml`, or a `SESSION_TITLE_TIMEOUT` |
| boot fails with `unknown config key "style"` | the checkout predates fork commit `4cbd1113d8` (a rebase dropped it) |
| slug titles but odd words (`explain-water` for everything) | tiny on-device model parroting the example in the system prompt; fine on cloud models |
