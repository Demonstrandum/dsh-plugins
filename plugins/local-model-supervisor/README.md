# tali-local-model-supervisor

Host local model servers from DSH itself: start them on first use, reuse them
across sessions, and shut them down once no session needs them. Written
2026-09-03 so the AFM server backing the Apple Foundation on-device model no
longer has to be started by hand (or die with the agent session that spawned
it). System-level context and the provider setup:
`~/projects/deepseek-harness/apple-foundation-model-provider.md`.

## Behaviour

| Situation | What happens |
|---|---|
| A session selects a model whose provider a server carries | Server is started (single-flight) and polled until its health URL returns 2xx |
| Another session uses the same provider | The running server is reused; no second process |
| The server is already healthy at first touch (started by hand, launchd, another dsh) | **Adopted**: reused, and never stopped by this plugin |
| Idle past `idleMinutes` AND no live session selecting its providers | Owned server gets SIGTERM (SIGKILL after 5s) |
| Child crashes | Logged; respawned on the next matching activity |
| Plugin unloads / dsh exits | Owned children are stopped; adopted ones are left alone |

Start is triggered by `model/selection` (warmup begins when the model is
picked, before the first message) and refreshed by `request/header`.

## Config

```yaml
servers:
  - id: afm                     # unique label, used in logs
    providers: [apple]          # llm provider ids whose traffic this serves
    command: afm                # executable, PATH-resolved; spawned without a shell
    args: ['--port', '9997']
    healthUrl: http://127.0.0.1:9997/v1/models   # 2xx = healthy; must be unauthenticated
    idleMinutes: 15             # shutdown window; 0/absent = never idle out
    startupTimeoutMs: 90000     # spawn-to-healthy deadline
    env: {}                     # optional extra environment
    logFile: /tmp/local-model-supervisor-afm.log  # child stdout/stderr (default: /tmp/local-model-supervisor-<id>.log)
```

Two servers may not claim the same provider (fails loudly at load).

## Limits

- "Last session closed" is approximated: no LIVE agent whose current model
  selection names the server's providers, plus the idle window. Web sessions
  stay loaded after a tab closes — the idle window covers that lag.
- A request racing a cold start can fail once; DSH's LLM retry policy normally
  bridges it. Selecting the model (rather than immediately sending) warms up.
- Only processes this plugin spawned are ever killed.

## Verified

Stub-context smoke tests against real `afm` (2026-09-03):

- spawn → healthy → owned child killed by the unload disposer;
- external server on the same port **adopted** and left running after dispose;
- idle sweep blocked while a live agent selects the provider, then stops the
  server once that agent is gone.
