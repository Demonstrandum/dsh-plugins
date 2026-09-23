# Cloud providers + API keys on every DSH instance of a shared machine

**Date:** 2026-09-23. **Scope:** the shared remote machine (one macOS account + one
DSH instance per colleague; inventory in the private extras notes). Seven of
its eight instances had no usable cloud provider — colleagues could open their
GUI but every turn fell back to the on-device Apple model. This recipe records
how DSH stores a provider and its key, the rollout tool that writes exactly
that over ssh, how the result was proven end-to-end without touching anyone's
sessions, and the two traps found on the way (a `bash` 3.2 array bug in the
public installer; a new account needs its deploy keys *before* the bootstrap).

## How DSH stores a provider and its key

Two files under `$DSH_HOME` (default `~/.dsh`), both `chokidar`-watched by the
running server, so edits apply live — provider sections re-register their
routes (`packages/llm/llm-pi-ai/src/index.ts`, `ensureRegistrationFacts`) and
`credentials-local` hot-publishes reference changes. No restart is needed.

1. **`settings.yaml`** — the provider *configuration*, never the secret:

   ```yaml
   llm-pi-ai:
     providers:
       anthropic:
         apiKeyEnv: ANTHROPIC_API_KEY      # a *reference name*, resolved per request
         requestImagePixelBudget: 1150000  # see anthropic-many-image-2000px-limit.md
         models: [ ... ]                   # optional catalog restatement, see below
       openrouter:
         apiKeyEnv: OPENROUTER_API_KEY
   agent-default-model:
     provider: anthropic
     model: claude-opus-5-5
     reasoningEffort: max                  # accepted by @deepseek-ai/dsh-agent-default-model
   ```

   `anthropic` and `openrouter` are pi-ai *catalog* providers: a bare row is
   enough, the models come from the installed catalog
   (`node_modules/@earendil-works/pi-ai/dist/providers/data/<provider>.json`).
   A `models:` list **replaces** that catalog for the route, so a list that
   adds one model must restate every shipped id (bare `- id:` entries inherit
   the catalog fields) — `anthropic-new-model-before-catalog.md`. That is why
   the anthropic row here is a 40-line block: pi-ai 0.85.1 lacks Claude Opus
   5.5 (ships from 0.87.1).

   The GUI (Settings → Providers) writes a bare `anthropic: {}`; that works
   too, because pi-ai's own ambient discovery asks the auth context for the
   provider's default variable (`ANTHROPIC_API_KEY`) and DSH answers it from
   the credential seam first (`authContextFrom().env`, `llm-pi-ai/src/auth.ts`).

2. **`.credentials.yaml`** (mode `600`, refused if group/world-readable):

   ```yaml
   version: 1
   records:
     client-connection/browser-session:   # written by the first `dsh web` launch; leave it
       kind: grant
       payload: { version: 1, secret: … }
   refs:
     ANTHROPIC_API_KEY: sk-ant-…
     OPENROUTER_API_KEY: sk-or-v1-…
   ```

   `refs.<NAME>` is what `apiKeyEnv: <NAME>` (and ambient discovery) reads.
   The parser rejects unknown top-level keys and the pre-`version` flat layout
   loudly (`packages/credentials/credentials-local/src/index.ts`), so write the
   file through a YAML library, not with `echo >>`.

## The rollout tool

`extras/bin/dsh-set-providers <host> --creds FILE [--only user,user] [--dry-run]`
(private extras repo; the host inventory it reads is private too). Per account,
over `ssh <user>@<host> bash -s`, it runs a Node script with the checkout's own
`yaml@2` (`YAML.parseDocument`, so existing comments and the browser-session
grant survive) that:

- **replaces** `llm-pi-ai.providers.anthropic` with the reference block (it
  carries the catalog restatement, so an older copy must not linger);
- adds `openrouter: {apiKeyEnv: OPENROUTER_API_KEY}` when absent (an existing
  row, even a bare `{}`, is kept);
- sets `agent-default-model` (`anthropic` / `claude-opus-5-5` / `max`) only
  when none is set — an existing choice stays;
- adds the two `refs` **only when absent** — two colleagues already held their
  *own* keys, which must survive (the tool prints `kept (own key)`);
- writes both files atomically (`tmp` + `rename`, mode 600) and chmods the
  credentials file to 600 regardless.

The keys travel inside the ssh stdin script as exported variables, never on a
command line (`ps` on the host would show argv). The creds file is a plain
`KEY=value` env file kept outside every repo. Output is one line per account,
e.g. `<user>  anthropic added; openrouter kept; default kept (openrouter/…); ANTHROPIC_API_KEY added; OPENROUTER_API_KEY kept (own key)`.

`LOCAL_TEST=1` runs the remote half on this Mac against `DSH_HOME` — that is
how it was tested first, on copies of the laptop's two files (diff: only the
intended rows and whitespace in unrelated inline comments changed).

## Proving it end-to-end (no GUI, no leftovers)

`dsh --profile headless "<task>"` runs one turn with the home's
`agent-default-model` and prints the answer (`packages/bundle/headless/README.md`).
Run it under a **temporary `DSH_HOME`** seeded with copies of the account's
`settings.yaml` + `.credentials.yaml`, so the colleague's real home gets no
`profiles/headless`, no stray session and no workspace entry:

```sh
ssh <user>@<host> 'bash -s' <<'R'
export PATH=/opt/homebrew/bin:$PATH        # non-interactive ssh has no brew on PATH
T=$(mktemp -d); mkdir "$T/home"; cp ~/.dsh/settings.yaml ~/.dsh/.credentials.yaml "$T/home/"; chmod 600 "$T/home/.credentials.yaml"
cd ~/github/tali-dash-plugins/deepseek-harness   # must run from the checkout: `pnpm dsh` resolves tsx there
DSH_HOME="$T/home" pnpm dsh --profile headless --json "Reply with exactly the two words: PROVIDER OK" 2>&1 | grep -E '"type":"(final|error)"'
rm -rf "$T"
R
```

To test the *other* route, rewrite `agent-default-model` in the temp copy
(e.g. `openrouter` / `anthropic/claude-haiku-4.5`) and run again. 2026-09-23:
17 such runs across the eight accounts (each account's default, plus the
other provider) all answered `PROVIDER OK`; an Opus 5.5 `max` turn on a
one-line prompt cost 4 input / 10 output tokens plus an 18 k prompt-cache write.

Restarting the instances was not required (live swap), but with no colleague
sessions running it was done anyway as insurance, sync-host style: kill the
listener on the web port, poke the relay (`web+3`), wait for its 401 — 3–4 s
each.

## Adding a new account on the shared machine (what changed since the bootstrap recipe)

The generic procedure is in `bootstrap-mac-installer.md` (§ `--instance`) and
the account script lives in extras. Two lessons from the 2026-09-23 account:

- **Deploy keys first.** The public bootstrap only *layers* the private extras
  submodule when the account can already fetch it; otherwise it logs "extras
  layer not reachable" and installs the public set. Relay the read-only deploy
  keys, the ssh `Include` and the `url.<alias>.insteadOf` rewrites onto the
  new account before running it (homes on a shared machine are `750`, so copy via
  your own Mac: `ssh a@h cat file | ssh b@h 'cat > file'`).
- **`tools/install-plugins.sh` died with `EXTRA_DIRS[@]: unbound variable`**
  the first time, right after every plugin had built. macOS `/bin/bash` is
  3.2, where `"${EMPTY[@]}"` under `set -u` is an error (fixed in bash 4.4);
  the array is empty exactly when extras is absent, which no earlier account
  had hit. Fixed with the portable `${ARR[@]+"${ARR[@]}"}` idiom at both
  expansion sites (`95e3335`). A second bootstrap run took the half-installed
  instance over and finished (`--replace` is the default).

The GUI-only step remains: someone must log the new macOS account in once
(Fast User Switching) so its `gui/<uid>` launchd domain exists for the relay
LaunchAgent; `launchctl print gui/$(id -u)` over ssh tells you when.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Turn fails with `MISSING_CREDENTIAL` for a configured route | `apiKeyEnv` names a ref that is not in `.credentials.yaml` | add `refs.<NAME>`; the file is watched, retry at once |
| Server refuses `.credentials.yaml` at boot | file readable by group/others, or flat pre-`version` layout | `chmod 600`; nest entries under `refs:` with `version: 1` |
| Provider row lists models but a new one is "unknown" | `models:` replaces the catalog; the id is missing from the list | restate it (bare `- id:` inherits catalog fields) or drop the whole list once pi-ai ships it |
| `bash: node: command not found` over ssh | non-interactive shells lack the Homebrew PATH | `export PATH=/opt/homebrew/bin:$PATH` first |
| `pnpm dsh … ERR_MODULE_NOT_FOUND` for `tsx` | ran `node --import tsx/esm apps/cli/src/bin.ts` from outside the checkout | `cd` into `deepseek-harness` and use `pnpm dsh` |
| `EXTRA_DIRS[@]: unbound variable` in install-plugins | bash 3.2 + `set -u` + empty array (no extras) | pull `95e3335` or newer |
| `timeout: command not found` on the host | macOS has no GNU `timeout` | drop it, or `brew install coreutils` (`gtimeout`) |
