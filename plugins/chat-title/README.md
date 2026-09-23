# tali-chat-title

Lets the agent name the chat, and has it do so at the start, as soon as the
conversation says what it is about. Host-only
(no client bundle); everything goes through the in-tree session-title service
(`ctx.sessionTitle`), so the sidebar, the `session/title` log event and the
built-in automatic titler all see the same title.

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

A `tool:chat-title` section placed after the tool sections, about 60 words:

> Chat title: every chat starts under a placeholder title. Call rename_chat as
> your first tool call once the user's message says what the chat is about.
> If the first message is only a greeting, call it the moment the goal is
> clear. Title: 5 or fewer lowercase words joined by hyphens, specific to the
> task (fix-login-redirect), not generic (help-request). Rename again only if
> the subject of the chat changes. Never override a title the user set
> themselves.

The style sentence follows `style`/`maxWords`. Only top-level agents see the
section (subagents cannot rename, so they are not told to). Kept short on
purpose: one clear instruction is followed more reliably than a long one,
and the nudge below carries the timing.

### Runtime-context nudge (`nudge`)

While the chat still carries only an automatic title (none / fallback /
provider), every request's runtime-context snapshot carries one extra line:
*"Chat title: not set yet. If the conversation says what this chat is about,
call rename_chat now, before other tools."* The text is constant, so it
appears once and disappears once (one snapshot change each) rather than
changing the prompt every turn. It clears both when the agent names the chat
and when the human does.

Measured (headless, Claude via OpenRouter, 2026-09-24): with a first message
that states a task the model calls `rename_chat` in its first step, alongside
its first `read`; with a bare "hi there" it answers without renaming and the
nudge stays for the next turn.

## Config

```yaml
- id: tali-chat-title
  config:
    toolName: rename_chat   # model-facing tool name
    style: slug             # slug (foo-bar-baz, matches the fork's session-title-llm `style: slug`) | natural
    maxWords: 5             # slug word cap / phrase-length guidance (1 to 12)
    promptHint: true        # the system-prompt section
    nudge: true             # the runtime-context reminder while untitled
```

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

- `session-title-llm` / `session-title-first-prompt-llm` (in-tree): still
  runs on the first prompt; the agent's `rename_chat` usually lands within
  seconds after it and supersedes it. Both write `session/title`; latest wins.
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
