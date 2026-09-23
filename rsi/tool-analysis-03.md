# Tool analysis 03 — round two, after fs-tools

Status: **analysis only, nothing built**. Written 2026-09-23 over every session in
the `deepseek-harness` and `tensatory` workspaces (86 sessions, 14,488 tool
calls). The natural experiment: `fs-tools` (`list_dir`, `read_many`,
`edit_many`, `search`) was mounted 09-16 ~23:25, so sessions are split into
**PRE** (46 sessions, 7,243 calls) and **POST** (40 sessions, 7,245 calls —
38 with bash, 3,454 bash calls). Scratch data + scripts:
`~/projects/deepseek-harness/rsi-validate/2/` (`classify2.py`, `*.jsonl`,
`seq-post.json`).

## 1. Did round one work? Partly.

| metric | PRE | POST | verdict |
|---|---|---|---|
| bash share of all tool calls | 58 % | **48 %** | down 10 pts |
| `cd X && …` prefix (% of bash) | 59 % | **25 %** | the `workdir` hint worked (workdir 7 % → 23 %) |
| standalone `ls` calls | 181 | **5** | `list_dir` (46 calls) absorbed the standalone case |
| `cat > f <<EOF` writes | 5.0 % of bash | 2.5 % | halved |
| `edit` error rate | 18.8 % | **9.5 %** | halved, but still the read-guard |
| `write` calls | 322 | 175 | halved (edit_many replaced rewrite-whole-file) |
| python-heredoc edits (`py_edit`) | 555 (18 % of bash) | **533 (15.4 %)** | **essentially unchanged** |
| bash `sed -n X,Yp` reads | 485 (15.8 %) | **538 (15.6 %)** | unchanged |
| bash `grep` searches | 918 (30 %) | **1,245 (36 %)** | **up** |
| `\| head` on bash calls | 49 % | 52 % | unchanged |
| `edit_many` error rate | — | **15.2 %** (50/330) | new worst tool |

Adoption of the new tools: `edit_many` 330, `read_many` 161, `search` 87,
`list_dir` 46. Every session with >20 bash calls used `edit_many` at least
once, so **the tools were available everywhere (tensatory included) — the
remaining bash use is a choice, not a configuration gap.** Note the fs-tools
system-prompt hint cannot be verified from the logs (the system prompt is not
recorded; see §6).

## 2. Why python heredocs survive (533 calls, incl. 206 in one session)

### 2.1 It is not a fallback after tool failure
Only **2 of 533** `py_edit` calls followed a failed `edit`/`edit_many` within
the previous 3 calls. Instead every heavy session shows a **mode switch**:
`edit_many` is used early (16 calls before seq 556 in `neural-nets`, 19 before
seq 619 in `dsh-server-installer-pkg`), then the agent switches to bash editing
and stays there (206 / 92 more heredocs). 65 % of all bash calls sit inside
same-tool runs of ≥3 — once in "bash mode", the agent stays in bash mode.

### 2.2 The tipping point is a *structural* edit the tools cannot express
`neural-nets` seq 556 (first heredoc): delete everything between two markers
(`s.index(start)…s.index(end)`), rename, **and typecheck in the same call**.
Seq 561: the next `edit` fails `FS_STALE_VERSION` (bash mutation invalidated
the read) → re-read → retry: a 2-round-trip tax that teaches "just stay in
bash". Seq 596/606: truncate-from-marker, replace-between-markers; 601: append
+ run tests.

Shapes across all 541 bash-side edits (py + node):

| shape | calls | % |
|---|---|---|
| plain `s.replace(a,b)` only (edit_many could do it) | 275 | 51 % |
| hand-rolled `assert a in s` (re-implementing the guard) | 384 | 71 % |
| replace **all** occurrences (`.replace(a,b)` without count) | 143 | 26 % |
| loop over (old,new) pairs | 69 | 13 % |
| region between two markers | 47 | 9 % |
| line-oriented ops (`splitlines`) | 21 | 4 % |
| JSON load/dump edit | 20 | 4 % |
| append (`cat >>`, `open(...,'a')`) | 19 | 4 % |
| truncate from marker | 9 | 2 % |

**`replace_all` was used 0 times in 625 native `edit`/`edit_many` calls**, yet
26 % of heredocs replace all occurrences. `dry_run` was also used 0 times.

### 2.3 The real driver: edit + verify in one round-trip
Of 449 plain-replace heredocs, what follows the `EOF`:

| chained after the edit | calls |
|---|---|
| `pnpm typecheck`/`tsc` | 173 |
| a peek (`grep`/`sed -n`/`tail`) | 113 |
| nothing | 70 |
| tests (`vitest`) | 39 |
| `git` | 32 |

And on the native side: **`edit(_many) → bash` is the most common non-bash
bigram in the corpus (342)** — edit, then a separate round-trip to typecheck.
Total "edit-then-verify" rituals ≈ 342 + 313 fused heredocs = **~650**.
`pnpm -s typecheck 2>&1 | grep -E "error|Failed"; echo ok` alone appears 235×.

## 3. `edit_many`: 50 failures

| cause | count | note |
|---|---|---|
| `file has not been read` (read-guard) | 31 | usually **one unread file in an N-file batch** → whole batch rejected, all args re-sent |
| `file changed since it was read` (stale) | 15 | 12 of 15 had a bash read/mutation of the same area just before (mixed-mode trap) |
| `old_string not found` | 4 | genuine |
| **partial apply** (`stopped at edit #2/#8 … Applied before the stop`) | 3 | version check runs at apply time, so staleness in file k leaves files 1..k-1 written — **not all-or-nothing as documented** |

After an `edit_many` failure the next call was `read_many` 19×, `read` 17×,
**`bash` 10×** (giving up on the tool).

## 4. Bash as a batch observer (the grep/sed/ls that did not move)

- **860 bash calls (25 % of bash) are pure observe-only bundles** of ≥2
  read-only segments (avg 2.7), 453 of them heterogeneous (grep + sed + ls in
  one call). `echo ---` separators appear in 698 calls (20 %).
- bash grep: 78 % of calls have ≥2 segments, 59 % run 2+ greps, 80 % cap with
  `| head`, 32 % grep *piped output* (not files), 22 % use `-A/-B/-C`.
- `sed -n`: 51 % co-occur with a grep in the same call, 24 % have 2+ ranges,
  median range 25 lines.
- `search` vs `grep` tool: 87 vs 132 calls, concentrated in 8 sessions;
  `search` errors (5) are all wrong-root relative paths.

So the competition is not `search` vs `grep`; it is **one bash call returning
N labelled results vs N tool calls**. Parallel tool calls in one message would
be one round-trip too, but the model does not treat them as equivalent.

## 5. The browser is the new bash

`chrome_evaluate_expression` is the **#2 tool in the corpus** (621 POST, 8.6 %
of all calls; 776 incl. safari/function variants), 6 % error rate.

- **68 % contain `await new Promise(r => setTimeout(r, N))`** — 484 calls
  with an explicit in-page wait, median 3 s, p90 9.4 s, 131 ≥ 5 s. The 12–15 s
  ones hit the MCP timeout (26 timeouts total, 7 on `chrome_get_screenshot`).
- **292 of 776 are repeats of the same normalised expression** within a
  session (89 groups): hand-rolled polling (23× "wait, find button", 12×
  `location.reload(); return 1`, 11× "wait 2.5 s, read `#info`").
- 45 % click/dispatch via JS instead of `chrome_click` (52 calls) — because
  `chrome_click` needs a snapshot uid first (extra round-trip).
- 20 % probe canvas/WebGL (tensatory), 22 % layout (`getBoundingClientRect`).
- The dev-loop ritual `bash → chrome_navigate → chrome_evaluate_expression`
  (111) `→ chrome_get_screenshot` (63): rebuild, reload, settle+probe, look.
  `chrome_navigate → chrome_get_screenshot` directly: **1**. Agents always
  interpose an evaluate to wait for render.
- Error recovery costs: `windowId does not belong / browser restarted` 15× →
  `chrome_open → evaluate` (2 extra calls each); `pass windowId` (multi-window)
  8× → `chrome_close → evaluate`. `neural-nets` closed/reopened Chrome 17×/11×
  instead of navigating.
- `chrome_wait_for` (text only) has a **16 % error rate** and 38 uses;
  `chrome_get_page_content` 18 %.

## 6. Other shapes

- **build/test**: 867 bash calls (25 %); `pnpm -s typecheck` 206 + `pnpm
  typecheck` 120 + `npx vitest` 176 + `vitest` 104; 91 % use `2>&1`, 76 % pipe
  to grep, 159 end with an `echo ok` sentinel (because a filtered pipe hides
  the exit code; only 29 use `$?`/`PIPESTATUS`).
- **git**: 646 calls (19 % of bash, up from 11 %): `log` 448, `add` 255,
  `commit` 244, `status` 233; 226 status/diff/log combos; 212/229 commits
  bundle `add`, 131 bundle `push`.
- **sleep**: 257 (7.4 % of bash); `wait` tool exists only since 09-22, too
  early to judge — but `fix-cmd-comma-shortcut` (created 4 min before the
  wait-tool session) still did `sleep 60/45/75; echo done`.
- `~/.dsh` reads: 235 (profiles 144, logs 58, sessions 39) — config
  inspection, not transcript decoding any more.
- `read`: 505 calls, 74 % with offset (median limit 40 lines); 56 forward-paging
  reads; 25 files read ≥3× in a session (121 reads). `read_many`: median 3
  files/call, 55 same-file multi-range.
- exact-duplicate calls within a session: `chrome_get_screenshot` 134 extra,
  `chrome_navigate` 97, `bash` 76, `chrome_evaluate_expression` 62,
  `edit_many` 40 (retry after guard failure), `chrome_open` 40, `chrome_close` 37.

## 7. Proposals (for discussion — ordered by round-trips × errors removed)

1. **`edit_many` gets `then`/`verify: {command, workdir?, max_lines?}`** — run a
   shell command after a *successful* apply and return its (shaped) output in
   the same result. Directly targets the ~650 edit-then-verify rituals and the
   #1 reason heredocs survive. (Same option on `edit`/`write`.)
2. **Structural edit ops in `edit_many`**: `{file_path, after: marker, insert}`,
   `{between: [start, end], new_string}` (delete/replace region),
   `{append: text}`, `{truncate_after: marker}`. Covers the 9 %+2 %+4 % shapes
   that *start* the bash-mode switch. Also surface `replace_all` in the
   description with an example (0 uses vs 143 in python).
3. **`edit_many` partial-batch behaviour**: (a) fix the atomicity hole (check
   versions of *all* files before writing any); (b) on `not_read` for one
   file, return the file's current content around each `old_string` so the
   agent can fix it in one round-trip instead of read + resend; or apply the
   valid subset and report the rejected edits (opt-in `partial: true`).
4. **Browser wait/poll primitives**: `chrome_evaluate_expression` gains
   `settleMs`/`waitFor: {selector | expression | text}` before evaluating;
   `chrome_wait_for` accepts a selector or JS predicate (not just text);
   `chrome_navigate` gains `then: expression` + `screenshot: true`. Targets
   the 484 in-page sleeps, 292 hand-rolled polls, 26 timeouts, and the
   3-call reload ritual (111/63).
5. **`chrome_click`/`chrome_fill` by CSS selector or text** without a prior
   snapshot (349 JS clicks vs 52 tool clicks). Also: after a browser restart,
   auto-reopen instead of erroring (15 errors → 30 wasted calls); default to
   the most recent window instead of `pass windowId` (8 errors).
6. **bash output shaping**: `max_lines`, `tail`, `grep` options and **always
   report the exit code of the *first* pipeline stage** (kills the `echo ok`
   sentinel + `2>&1 | grep -E error` idiom, 235+159 calls). A `run_checks`
   tool (typecheck/test presets per repo) is the special case.
7. **A generic `batch` tool** (run N tool calls, return N labelled results) —
   the only honest answer to the 860 heterogeneous observe bundles; or,
   cheaper, teach via prompt that parallel tool calls are one round-trip.
8. Low priority: `git_status`-style summary tool (226 status/diff/log combos);
   `list_dir`/`search` accept `~` and repo-relative roots (5 `search` errors);
   `read` paging (56) → suggest `read_many` ranges in the "truncated" footer.

## 8. Gaps in the `transcript_*` tools met during this analysis

1. **No `until` / cohort split in `transcript_tool_stats`** — PRE had to be
   computed as ALL − POST; impossible for latencies/percentiles. Want:
   `since`/`until`, or `split_at: <date>` returning two columns.
2. **No cross-session args export** — used the hack `transcript_grep
   pattern:"[\s\S]" context_chars:20000 fmt:jsonl` (excerpts truncate; 1 of
   3,454 lost). Want `transcript_export {sessions, since, until, kinds, tools,
   fields}` → jsonl with full args/results.
3. **jsonl rows carry no `ok`/error flag, latency, or call↔result id** —
   errors were inferred from an `^Error` prefix (183 vs 180 real), calls
   paired to results by tool-order heuristics. Want `callId`, `ok`, `code`,
   `latencyMs`, `resultChars` on every call row.
4. **No sequence analytics**: bigrams/trigrams, same-tool run lengths,
   duplicate-call detection, "what preceded X" — all done in python here.
   Want `transcript_tool_stats` modes: `sequences` (n-grams, runs),
   `duplicates`, `before_error` (mirror of the existing after-error table).
5. **No arg-shape stats**: e.g. "% of `read` with offset", "edits per
   `edit_many`", "`replace_all` usage" — a `transcript_tool_stats
   args:true` histogram of present keys per tool.
6. **`transcript_find` lacks model, cwd, call/error counts** — needed 5
   `transcript_outline` calls to check the model of 5 sessions.
7. **The system prompt / registered tool list is not in the log**, so "was
   tool X available in session S" is unanswerable except by observing use.
   Recording the tool-name list (not the full prompt) at session start would
   make adoption studies exact.
8. Minor: `transcript_grep` `sessions` glob has no per-session cap, so a
   1,000-call session dominates; a `per_session_limit` would help sampling.
