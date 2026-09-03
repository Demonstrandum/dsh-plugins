# tali-dash-plugins

Local-only plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
One directory per plugin under `plugins/`. See `AGENTS.md` for the full development guide.

## Quick start

```sh
cd plugins/agent-status-indicator
pnpm install
pnpm build          # or: pnpm watch

# from the DSH checkout:
cd ~/github/deepseek-harness
pnpm dsh web --patch /Users/USER/github/tali-dash-plugins/cordis.dev.yml
```

## Plugins

- `agent-status-indicator` — floating emoji at the bottom-right of the chat
  area showing the agent's state: 🙂 waiting · 🤨 thinking · 😶 error ·
  per-tool icon while a tool call runs ([>] terminal SVG for bash, ✏️ edit/write, 👁️ read,
  🔍 grep/glob/search, 🌐 web, 🤖 subagent, 🔧 fallback; rule table ported
  from pi-web's toolIcons system) · ✋ badge when blocked on your input.
- `browser-automation` — one browser per chat: mounts Apple's Safari MCP server
  (`safaridriver --mcp`, Safari Technology Preview) and Google's
  `chrome-devtools-mcp` into each agent's own scope on `agent/created`, so
  concurrent sessions never share a page list. Tools: `mcp__safari__*`,
  `mcp__chrome__*`. Host-only (no client half). See its README.
