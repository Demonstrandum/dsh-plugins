# no-global-tools

An **agent-preset row**, not a profile plugin: mounted from a preset's
`agent.cordis.yml`, it runs in the agent scope and calls
`ctx.tools.restrict({ allow: [] })`, hiding every deployment-global tool from
the agents composed under that preset. Scoped registrations made *inside* the
preset stay visible (that is `restrict`'s contract).

Why: host plugins register their tools globally (`ctx.tools.register` in the
web profile), so a chat-only preset that merely omits the in-tree tool groups
still ships them all. Measured 2026-09-21 on a `minimal-no-tools` session with
the Apple on-device model: 62 tool schemas / 62 KB in the request, one output
token, `stopReason: length`.

```yaml
# ~/.dsh/.agent-presets/minimal-no-tools/agent.cordis.yml
- id: no-global-tools
  name: /abs/path/to/tali-dash-plugins/plugins/no-global-tools/index.js
```

Not sufficient on its own for plugins that register **per agent** on
`agent/created` (`browser-automation` and its kind): those are
scoped registrations and exempt from `restrict`. They gate themselves with
their `skipPresets` config (default `['minimal', 'minimal-no-tools']`) and
detach/re-attach on `agent-preset/selected`, because a blank session may be
switched by `enforce-model-preset` after creation and `recompose` keeps the
same Agent.

`restrict()` refuses a context-global call by design — this module must be a
preset row, never a profile row.
