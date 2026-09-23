# fs-tools plugin — batch `list_dir` / `read_many` / `edit_many` / `search` beside the built-ins

Status: **built, verified and live 2026-09-16** (18 tests, three headless runs
against a throwaway home with the real observation policy); mounted in the
**live web profile** (`~/.dsh/profiles/web/cordis.patch.yml`, row
`tali-fs-tools`, absolute-path `name` like the other rows — hot-reloaded on
save, on the maintainer's go-ahead) and therefore NOT repeated in `cordis.dev.yml`. Plugin README:
[`plugins/fs-tools/README.md`](../plugins/fs-tools/README.md).

## 0. Why

The `transcript_*` corpus pass ([`rsi/tool-analysis-02-validation.md`](../rsi/tool-analysis-02-validation.md),
41 sessions / 3,076 bash calls) showed agents mutating files through bash
1.5× more often than through `edit`+`write` (555 python heredocs, 154
`cat > f <<EOF`, 78 `sed -i`), reading with `sed -n` (485) more than with
`read` (369), searching with bash `grep` 8× more than with the `grep` tool,
and running `ls` 511 times while `glob` (files only) was used once. `edit` had
a 19 % error rate, 39 of 48 errors being the read-guard (`FS_NOT_OBSERVED` /
`FS_STALE_VERSION`) — because bash-side reads are invisible to the observation
policy and bash-side writes move the version. The drivers, measured: 67 % of
the heredocs batch ≥ 2 replacements, 55 % chain a typecheck in the same call,
57 % hand-roll `assert s.count(old)==1`.

Decisions taken (with the maintainer, 2026-09-16): build 1+2+3 of the re-ranked list as
one plugin; **new names beside the built-ins** (zero risk to the live profile,
adoption measurable later with `transcript_tool_stats`), not shadowing.

## 1. What was built

`plugins/fs-tools/` — plain ESM, no build step:

| file | role |
|---|---|
| `index.js` | `name`, `inject = ['tools','fs','systemPrompt']`, `Config`, `build(ctx, config)` → 4 tool defs, `apply` (+ one system-prompt section, `promptHint`) |
| `common.mjs` | `FsToolsError` (HarnessError → `code` reaches `result.error`), session cwd + sandbox policy per call, `~` expansion, fs error → model-facing message, `N: text` window rendering |
| `list-dir.mjs` | `ctx.fs.resolve → stat → listDir`, BFS to `depth`, collapsed noise dirs, several roots, inline per-root errors |
| `read-many.mjs` | per entry `stat` + `readText`, one read per distinct file, **`ctx.emit('fs/observed', target, {kind:'present', version})`** |
| `edit-many.mjs` | validate (waterfall `fs/edit-intent`, read current text, simulate edits in order, uniqueness) → apply (`editText` with intent version, emit observed) |
| `search.mjs` | `rg --no-config --json` argv, `ctx.subprocess.spawn` (child_process fallback), per-file records, `exclude_pattern` post-filter with context re-trim, files/count aggregation, path-sorted |
| `tests/fake-ctx.mjs`, `tests/tools.test.mjs` | real-fs fake `ctx` with version counter, sandbox codes and a mini observation policy |
| `cordis.patch.yml` | bundle row `tali-fs-tools` for `dsh plugin add` |

### How the guard integration works (the part worth understanding)

`@deepseek-ai/dsh-fs-observation-policy` is an event gate: it records
`fs/observed` (owner session → target → `{present, version}` / `absent`) and
decides `fs/edit-intent` (throws `FS_NOT_OBSERVED` for an unseen target, else
returns `{ version }` as the compare-and-swap basis). It never touches the
filesystem. So:

- `read_many` emits `fs/observed` after each successful read → the policy
  treats it exactly like `read`.
- `edit_many` calls `ctx.waterfall('fs/edit-intent', target, exec, () => undefined)`
  per file during validation (refusal collected, nothing written) and again per
  edit during apply; `ctx.fs.editText(target, edit, intent, signal, policy)`
  does the atomic version check in the backend; then `fs/observed` with the new
  version so the next edit to the same file (in this call or a later `edit`)
  sees a fresh record.
- Without the policy plugin the waterfall falls through to `undefined` and
  edits are unconditional — same as `edit` (tested).

Source of truth for this: `<dsh-src>/packages/fs/tool-fs/src/{read,edit}.ts`,
`packages/fs/fs-observation-policy/README.md`, `packages/fs/fs/src/index.ts`
(`FileSystem` abstract: `resolve`, `stat`, `listDir`, `readText`, `editText`,
`writeText`).

## 2. Verification

1. `cd plugins/fs-tools && pnpm check` — 18 tests: registration + prompt hint;
   list_dir (collapse, depth, sizes, several roots, inline errors, cap);
   read_many (ranges, observation events, absent/dir inline, collapse_blank,
   budget); edit_many (unread refused with all problems listed, read_many
   authorises, multi-edit same file incl. matching earlier output, replace_all,
   dry_run, bash-side write → stale before any write → re-read fixes, sandbox
   marker, no-policy unconditional, arg validation); search (argv safety,
   context/gaps, files/count, include/exclude, several patterns,
   exclude_pattern, no_ignore, literal, cap, rg diagnostic).
2. Composition: `DSH_HOME=$H pnpm -s dsh --profile headless --patch $H/overlay.yml --dump-config`
   shows the row (`name: file:///…/plugins/fs-tools/index.js`).
3. **Headless end-to-end** against a throwaway home and a scratch workspace,
   with the real fs-local + fs-sandbox + observation policy:

   ```sh
   H=/tmp/dsh-fstools-home; mkdir -p $H; cp ~/.dsh/settings.yaml ~/.dsh/.credentials.yaml $H/
   cat > $H/overlay.yml <<'EOF'
   - insert:
       - id: tali-fs-tools
         name: '/Users/USER/github/tali-dash-plugins/plugins/fs-tools/index.js'
   EOF
   W=/tmp/fstools-ws; mkdir -p $W/src && cd $W && git init -q   # + a few small files
   DSH_HOME=$H node ~/github/deepseek-harness/apps/cli/lib/bin.js --profile headless \
     --patch $H/overlay.yml "Using only the named tools: (1) edit_many … EXPECTED to fail … (2) read_many … (3) edit_many … (4) search mode count … (5) search context 1 …"
   ```

   Observed: (1) `Error: edit_many: 1 problem, nothing written: #1 cannot modify … has not been read`
   (code `EDIT_MANY_INVALID` on the result); (3) `applied 2 edits in 2 files` and
   the files changed; (4)/(5) counts and context rows correct; zero
   `INVALID_TOOL_OUTPUT`. Note: running **`node <checkout>/apps/cli/lib/bin.js` from
   the scratch directory** makes it the session workspace — unlike the tsx
   source entry, the built bin resolves modules fine from another cwd.

## 3. What failed and why

| Symptom | Cause | Fix |
|---|---|---|
| `inject = { required: [...], optional: [...] }` | Cordis `inject` is an array or a name→config map; there is no optional form | array `['tools','fs','systemPrompt']`; `subprocess`/`sandboxPolicy` via `ctx.get` per call |
| `import { HarnessError } from '@deepseek-ai/dsh-tools'` undefined | dsh-tools does not re-export it | `link:` `@deepseek-ai/dsh-llm` and import from there (a plain `Error` would lose `code` in `result.error`) |
| `read_many files: ['a.ts']` → `"files[0]" must be an object` | schema `items` was object-only | `items: { oneOf: [{type:'string'}, {type:'object', …}] }` — the DSL supports `oneOf` and Anthropic accepted it |
| search `files` order differed run to run | ripgrep walks in parallel | sort files by path before capping |
| `exclude: ['util/**']` did not skip `src/util/` | gitignore glob semantics: a glob with `/` anchors at the root | `**/util/**`; documented in the parameter description |
| two headless runs died with Anthropic `Internal server error` | transient provider 500s (a trivial prompt with the same overlay passed) | retried; all later runs clean |

## 3a. Round two (2026-09-23): what the first week showed, and what changed

`rsi/tool-analysis-03.md` measured the week after the mount (40 sessions,
7,245 calls): standalone `ls` vanished (181 → 5) and `edit`'s error rate
halved, but **python-heredoc edits did not move (555 → 533)** and `edit_many`
became the worst tool (15 % errors). The causes, and the fixes in this round:

| Finding | Change |
|---|---|
| 59 % of heredocs chain `pnpm typecheck`/tests/`grep` after the edit; `edit(_many) → bash` is the #1 bigram (342) — edit-then-verify is ~650 round-trips | `verify: { command, workdir?, timeout_ms?, max_lines? }` runs after a successful apply through `ctx.shell` (`ctx.get('shell')`, optional; `shellEnv.collect` when present; the caller's sandbox policy); output tailed; non-zero exit reported, not an error |
| the switch into "bash mode" starts with a *structural* edit (delete between markers, truncate, append: 9 % + 2 % + 4 %) that `edit` cannot express | `op`: `insert_after`, `insert_before`, `replace_between` (`end` omitted = EOF, `inclusive`), `append` — translated to marker-anchored literal edits, `append` via `writeText` + `replaceIfVersion` |
| `replace_all` used 0× while 26 % of heredocs replace every occurrence | the ambiguity message now says `set replace_all: true`; the prompt hint names it |
| 31 of 50 `edit_many` failures: one unread file in an N-file batch → whole batch resent; 15 stale (12 after a bash mutation) | **unread/stale files are read by the tool; unique anchors go through** (result says so); otherwise the matching / nearest **regions** come back and `fs/observed` is emitted with the current version so the plain retry is authorised. Decision (the maintainer): the guard is anti-blind-overwrite, a unique anchor is not blind |
| 3 partial applies (`stopped at edit #8 … Applied before the stop`) — the version check ran only at apply time | validation compares `intent.version` with `stat().version` for every file before anything is written; apply-time CAS remains for true races |
| 5 `search` failures were rg's raw `No such file or directory` | roots are checked through `ctx.fs` first (`~` expands); existing roots are searched, missing ones named with the cwd they resolved against; all-missing is `SEARCH_NO_PATHS` |

The fake ctx gained a `/bin/sh` `shell` (`withShell: false` to drop it); 23
tests. Prompt hint updated accordingly.

## 4. Not done / next

- **Adoption measurement**: `transcript_tool_stats sessions:["*"] split_at:<mount date> sections:["all"]`
  (session-introspect §2.7) — do `py_edit` and the `edit_many → bash` bigram drop;
  does `verify` get used; what do the reactions under `edit_many` errors say now?
- Remaining proposals from the validation: bash cwd echo / sticky `workdir`
  (1,825 `cd` prefixes), bash output shaping, `wait_for_http`, the stale
  escalation-hint message, `dsh_dev_instance`.
- `presentResult` for `read_many` (a `read` card) and `list_dir` — generic
  cards for now.
