# tali-chat-title

Lets the agent rename the chat, as a reviewer of the automatic title rather
than a second titler. The in-tree LLM titler (`session-title-llm`, mounted in
`base`) names every chat from the first message with a cheap side request;
this plugin shows the agent that title in the runtime context and has it
rename only when the title is wrong or generic (a greeting-only first
message), when a more accurate name suggests itself in the first few turns,
or when the subject moves. Titles come out in the titler's configured style.
Host-only (no client bundle); everything goes through the session-title
service (`ctx.sessionTitle`), so the sidebar, the `session/title` log event
and the titler all see the same title.

## What the model gets

### `rename_chat` tool

```
rename_chat { title: string }
```

Renames the calling agent's own session. The title is styled first
(`style: slug` → `foo-bar-baz`, capped at `maxWords`; `style: natural` →
whitespace-collapsed phrase), then applied with `ctx.sessionTitle.rename`,
which logs a `session/title` event with `source.kind: 'user'`, the same
event the sidebar's Rename menu produces. That pins the title: the automatic
titler (`session-title-llm`) stops retitling.

Outcomes (the canonical value is `{ applied, title, … }`; the model sees a
one-line rendering):

| situation | result |
|---|---|
| placeholder title (fallback / provider) or a title this tool set earlier | renamed; `previous` carries the old title |
| same title as the tool already set | `applied: false, reason: 'unchanged'` |
| the human renamed the chat (sidebar Rename, `slug:` prefix) | `applied: false, reason: 'user-titled'`; the model is told not to call the tool again |
| empty after normalization (`"!!!"`) | error `CHAT_TITLE_EMPTY` |
| called from a subagent session (`header.parentSession` set) | error `CHAT_TITLE_SUBAGENT` |

"Human vs agent" is decided from the log, not from memory: the tool writes
the applied title into its `tool/result` `meta.chatTitle` (via
`presentationMeta`), so after a server restart a `user`-sourced title that
matches any `meta.chatTitle` in the session is still recognized as the
agent's own and may be replaced; any other `user`-sourced title is the
human's and is never overridden.

### System-prompt section (`promptHint`)

A `tool:chat-title` section placed after the tool sections, 80 words:

> Chat title: the chat is titled automatically from the first message; the
> current title appears in the runtime context. Call rename_chat when that
> title is wrong or generic (for example after a greeting-only first
> message), when a more accurate name suggests itself within the first few
> turns, or when the subject of the chat changes. Title: 5 or fewer lowercase
> words joined by hyphens, specific to the task (fix-login-redirect), not
> generic (help-request). Never override a title the user set themselves.

The style sentence follows the resolved style (see Config). The section is
emitted only when the assembling agent is top-level (subagents cannot
rename) and its scope can see the tool: a preset without tools, such as the
`minimal-no-tools` preset used for Apple Foundation and other models without
tool use, restricts the agent's tool view (`ctx.tools.restrict({ allow: [] })`),
so neither the section nor the line below is sent there.

### Runtime-context line (`nudge`)

While the chat carries an automatic title, the runtime-context snapshot
carries the title itself so the agent can judge it. The two automatic
sources read differently:

- fallback (the first words of the first message, written immediately):
  *"Chat title: "Please read notes.py and tel" is a placeholder (the first
  words of the first message). Call rename_chat with a real title once you
  know what this chat is about."*
- provider (the LLM titler's result, a few seconds later): *"Automatic chat
  title: "Summarize contents of notes.py file". Keep it if it describes this
  chat; call rename_chat if it is wrong or generic, or if the work so far
  suggests a more accurate name."*

Before any title exists there is nothing to review and the line is empty; it
is empty again once the agent or the human has named the chat. The text
changes at most three times per chat (fallback, provider, gone), each an
appended snapshot message. Same gating as the section.

Measured (headless, Claude via OpenRouter, 2026-09-24), same task prompt:
with the titler on, the agent read the file and kept "Summarize contents of
notes.py file" (no `rename_chat` call); with the titler row disabled, it saw
the placeholder line and renamed to "Summarize notes.py contents".

## Config

```yaml
- id: tali-chat-title
  config:
    toolName: rename_chat   # model-facing tool name
    style: inherit          # inherit (default) | slug | natural
    # maxWords: 5           # slug word cap / phrase length; unset = the titler row's targetWords, else 5
    promptHint: true        # the system-prompt section
    nudge: true             # the runtime-context line while the title is automatic
```

`style: inherit` reads `style` (and, when `maxWords` is unset, `targetWords`)
from the loader row of the in-tree titler (`@deepseek-ai/dsh-session-title-llm`,
`-first-prompt-llm` or `-all-prompts-llm`, whatever the profile mounts), so
agent titles and automatic titles come out in one form: `slug` on a profile
that sets the fork's `style: slug`, `natural` (the in-tree default) otherwise.
The values are read when this row loads; after changing the titler row's
style, reload this row (or restart) for the agent's titles to follow.

## Install / try

```sh
cd plugins/chat-title && pnpm install && pnpm run check        # unit tests (node --test)
# dev overlay row (absolute path): see ../../cordis.dev.yml
# bundle install into a profile:
dsh plugin --profile web add ./plugins/chat-title
```

The recipe (`recipes/chat-title-plugin.md`) has the headless end-to-end
method (throwaway home + forwarded credentials) and the traps hit on the way.

## Interaction with the other title plugins

- `session-title-llm` / `session-title-first-prompt-llm` (in-tree): does the
  naming; this plugin reviews. The sequence in a chat: fallback title at the
  first prompt, provider title a few seconds later, and the agent sees each
  in its next request's runtime context. If the agent renames while the
  titler is still running, `sessionTitle.rename` aborts that generation, and
  the `user`-sourced result stops later automatic retitles, so the two never
  overwrite each other. With the `all-prompts` variant the same holds: once
  the agent has renamed, the titler no longer schedules.
- `session-title-slug` (this repo): a `some-slug: ` prompt prefix renames at
  send time with `source.kind: 'user'` and no `meta.chatTitle`, so this
  plugin treats it as a human title and the model is told to leave it alone,
  which is the intent of typing a slug by hand.

## Known limitations

- A human title equal to a title the agent once applied is indistinguishable
  from the agent's own (both `user`-sourced, same string) and may be renamed.
- Under PTC mode a `rename_chat` sub-dispatch carries no `presentationMeta`
  (nested dispatches have no cards); the in-process `WeakMap` still records
  the applied title, but a restart then reads it as a human title. Harmless:
  the model is merely told not to rename again.
