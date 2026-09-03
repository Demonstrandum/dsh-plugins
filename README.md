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

- `agent-status-indicator` — floating emoji in the chat area showing the agent's
  state: 🙂 waiting · 😕 thinking · 🔧 blocked on a tool interaction · 😶 error.
