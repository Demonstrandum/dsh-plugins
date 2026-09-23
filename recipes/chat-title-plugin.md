# Recipe: let the agent name the chat, early (`chat-title` plugin)

**Goal (the maintainer, 2026-09-24):** a plugin that lets agents rename the chat title,
and has them name the chat at the beginning, as soon as the conversation
carries the minimum context needed to name it.

Plugin: `~/github/tali-dash-plugins/plugins/chat-title/` (package
`tali-chat-title`; the README owns the tool contract, config and the
human-vs-agent rule). This recipe owns the survey, the design choices and the
headless verification method.

## Survey: the seams a host plugin has

Checked against the source checkout (`deepseek-harness/`, fork branch
`feat/embed-session`, 2026-09-24):

| Fact | Where |
|---|---|
| `ctx.sessionTitle.rename(session, title)` appends `session/title` with `source.kind: 'user'`; that **pins** the title (in-flight automatic generation is superseded, later prompts schedule none). `refresh()` is the only unpin. There is no "agent" source kind; the service knows `fallback`, `provider`, `user`. | `packages/session/session-title/src/index.ts` |
| A tool body receives `exec.agent.session` (the live session), the same handle `fs-tools` uses for the cwd. | `packages/core/tools/src/index.ts` `ToolExecutionInput.agent` |
| `session.header.parentSession` marks a subagent session. | `packages/core/session/src/types.ts` |
| `output.presentationMeta(args, value)` is persisted as `tool/result.meta` (skipped for nested PTC dispatches). | `docs/cookbook/adding-a-tool.md`, tools `index.ts` ~1815 |
| `ctx.systemPrompt.section({ name, order, text })`: `text` may be a function of the `AssembleContext`, which the agent loop extends with `agent` (`context.agent?.session`, as `sandbox-policy` reads it). | `packages/core/system-prompt/src/index.ts`, `packages/sandbox/sandbox-policy/src/index.ts` |
| `ctx.systemPrompt.context({ name, order, text })` contributes to the **runtime-context snapshot**: a plugin-sourced user message re-emitted only when the joined text changes (`RuntimeContextProjection.project`). Empty text contributes nothing. | `packages/core/agent-loop/src/runtime-context.ts` |
| The `base` bundle mounts `session-title` + `session-title-first-prompt-llm`, so `web` and `headless` both have `ctx.sessionTitle`. The live profile sets `style: slug` on the LLM titler. | `packages/bundle/base/cordis.patch.yml`, `~/.dsh/profiles/web/cordis.patch.yml` |

## Design

Three pieces, one plugin, all host-side:

1. **`rename_chat` tool**: styles the title in the titler's style (read from
   the `session-title-llm` loader row via `ctx.loader.entries()`; `natural`
   when the row sets none, which is the in-tree default), calls
   `ctx.sessionTitle.rename` on the agent's own top-level session, and
   records the applied title in `tool/result.meta.chatTitle`.
2. **System-prompt section**: one paragraph of 80 words. The agent is a
   reviewer: rename when the automatic title is wrong or generic, when a
   more accurate name suggests itself within the first few turns, or when
   the subject changes. Only emitted when the agent's scope can see the
   tool (no-tools presets hide it).
3. **Runtime-context line**: the current automatic title, worded as a
   placeholder to replace (service `fallback`) or as a result to keep unless
   wrong (`provider`). Empty before any title and after a `user`-sourced one.

### How the design got here

- First draft: the agent names every chat as its first tool call, under a
  135-word MUST-worded section and a constant "not named yet" nudge. It
  worked (rename in step 1 beside the first `read`), but duplicated the
  in-tree titler, which names every chat anyway with a cheap side request:
  for a task-stating first message the two produced near-identical titles
  (`summarize-notes-py` vs "Summarize contents of notes.py file"), and the
  agent's copy cost main-loop tokens.
- The maintainer asked why the paragraph was so long; it was cut to one paragraph
  (behaviour unchanged, re-measured).
- The maintainer asked how this differs from `session-title-llm`, then to make the two
  integrate. Result: the reviewer design above. A coworker added: respect
  the titler's `style` flag, tell the agent to rename of its own accord when
  a better name appears in the first few turns, and turn the prompt off for
  providers without tool use (Apple Foundation). All three are in.
- The nudge text was first kept constant to avoid snapshot changes; showing
  the title costs at most three snapshot messages per chat and is what makes
  review possible, so the title is shown.

### Why "user"-sourced titles need a plugin-side distinction

`rename` can only write `source.kind: 'user'`, so a title the *human* chose
(sidebar Rename, `session-title-slug`'s `slug:` prefix) and a title the
*agent* chose look identical in the log. The agent must never override the
human's, but must be allowed to rename over its own when the subject moves.
Resolution: the tool persists what it applied in `tool/result.meta.chatTitle`
(`presentationMeta`), and classifies the standing title by scanning the
session events (`agentTitlesOf` → `classifyTitle` in `title.mjs`): a
`user`-sourced title matching a persisted `meta.chatTitle` is the agent's,
anything else `user`-sourced is the human's. Restart-proof, no side file.

### Rejected alternatives

- **Registering a `SessionTitleProvider`** (`ctx.sessionTitle.register`):
  the service accepts one provider; the in-tree LLM titler already holds the
  slot, and a provider generates from *human messages* on the service's
  cadence, not on the agent's judgement of "enough context".
- **`agent.inject` reminders from a `agent/turn-stopping` hook**: durable
  user messages pile up in the log every turn; the runtime-context snapshot
  is the seam built for exactly this ("dynamic context, re-emitted when it
  changes").
- **Hiding the tool from subagents via scope**: the global registry is
  simpler; the tool refuses with `CHAT_TITLE_SUBAGENT` and the section/nudge
  text providers return `''` when `header.parentSession` is set.
- **A `force` flag to override the human's title**: a model would use it.
  The refusal is final; the human can always rename.

## Build / test

```sh
cd ~/github/tali-dash-plugins/plugins/chat-title
pnpm install && pnpm run check     # node --test: styling, classification, tool paths, apply wiring
```

## Headless end-to-end (the method that worked)

The preview server's default model has no tools, so the tool path was
verified headlessly against a throwaway home with forwarded credentials
(PREVIEWING.md):

```sh
H=/tmp/chat-title-home; mkdir -p $H /tmp/chat-title-tmp
cp ~/.dsh/.credentials.yaml ~/.dsh/settings.yaml $H/
cat > /tmp/chat-title-overlay.yml <<'EOF'
- insert:
    - id: tali-chat-title
      name: '/Users/<user>/github/tali-dash-plugins/plugins/chat-title/index.js'
EOF
cd ~/github/tali-dash-plugins/deepseek-harness
TMPDIR=/tmp/chat-title-tmp DSH_HOME=$H node --import tsx/esm apps/cli/src/bin.ts \
  --profile headless --patch /tmp/chat-title-overlay.yml --dump-config | grep -A2 chat-title
TMPDIR=/tmp/chat-title-tmp DSH_HOME=$H node --import tsx/esm apps/cli/src/bin.ts \
  --profile headless --patch /tmp/chat-title-overlay.yml \
  "Please read /tmp/chat-title-ws/notes.py and tell me in one sentence what it contains."
zstd -dc $H/sessions/*/session-*/session.v3.jsonl.zstd \
  | grep -o '"type":"\(session/title\|tool/call\)".\{0,160\}'
```

Observed with the reviewer design (Claude via OpenRouter, 2026-09-24):

- Titler on: fallback title (seq 14), provider title "Summarize contents of
  notes.py file" (seq 16), then the agent's `read` and answer with **no
  `rename_chat` call**. The step-1 runtime context had no title line (the
  titler had not written yet); step 2's carried the provider title for review.
- Titler disabled (`- id: session-title-llm` / `disabled: true` in the
  overlay): only the fallback "Please read /tmp/…/notes.py and tel" existed;
  the agent saw the placeholder line and called `rename_chat` with
  "Summarize notes.py contents" (natural style: the throwaway home has no
  `style: slug` patch, so `inherit` resolved to the in-tree default).

The first-draft design (agent names every chat first) was measured the same
way: `rename_chat` in turn 1 step 1 beside the first `read`; a bare
`hi there` produced no tool call.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `pnpm dsh …` in the checkout fails with `× create the temporary package manager install directory … Operation not permitted` | pnpm 12's version manager tries to install the `packageManager`-pinned pnpm 11 into a temp dir the agent sandbox denies. Bypass pnpm: run the script's command directly, `node --import tsx/esm apps/cli/src/bin.ts …` **from the checkout root** (tsconfig `paths` resolution; from another cwd you get `does not provide an export named 'FiberState'` or `Cannot find package 'tsx'`). |
| `error: unknown option '--cwd'` | The headless profile takes no cwd flag; the session cwd is the process cwd. Reference files by absolute path in the task instead. |
| Model never calls `rename_chat` | Check the system prompt contains the `Chat title:` section (a `system/message` event) and that the runtime-context snapshot lists `chat-title:nudge`. If the section is missing, `ctx.tools.get(toolName, scope)` returned undefined: the tool is hidden in that scope (preset tool filter). |
| Tool answers `Not renamed: the user named this chat …` although nobody did | A `user`-sourced title with no matching `tool/result.meta.chatTitle`: another plugin renamed with `rename` (e.g. `session-title-slug`'s prefix), or the rename ran as a PTC sub-dispatch (no meta persisted) before a restart. By design; rename in the sidebar if it matters. |
| Preview (`~/.dsh-preview`, :3088) shows the section but the model ignores it | The preview's Apple Foundation model has no tools (`minimal-no-tools`); use the headless method above. |

## Status

- Built, unit-tested (9 tests), verified end to end headlessly (task prompt
  → renamed in step 1; greeting → not renamed).
- **Live since 2026-09-24** (the maintainer: "make it live"): installed into the `web`
  profile as a bundle: `node --import tsx/esm apps/cli/src/bin.ts plugin
  --profile web add <plugins>/plugins/chat-title` from the checkout (the
  `pnpm dsh` wrapper hits the temp-dir trap above; the write under
  `~/.dsh/profiles/web` needed one sandbox approval). `chat-title` is in
  `tools/install-plugins.sh`'s live set, so `pnpm install-plugins` reproduces
  it on another Mac. A bundle add is a **boot-time** change, yet the plugin was
  active in the running server within the same session: the very next request
  of the installing chat carried the `chat-title:nudge` runtime context, its
  `rename_chat` call renamed the live session, and the nudge was gone from
  the following snapshot. Profile bundle changes are picked up live
  (same observation as `brand-kit-plugin.md`'s "new bundle row taking effect
  live without a restart").
- The `cordis.dev.yml` row remains for the preview home (`~/.dsh-preview`),
  which does not carry the bundle; one home gets one or the other, never both.
- `--dump-config` on the live profile fails with `EPERM … profiles/web/cordis.yml`
  from an agent sandbox (read denied outside the workspace); run it from a
  terminal to list the composed rows.
