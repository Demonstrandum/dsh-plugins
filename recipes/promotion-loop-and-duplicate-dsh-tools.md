# The dsh-promote launchd loop (2026-09-20)

Status: **root cause found and stopped.** Written up so the next agent does not
recreate it, and so the leftover questions get answered.

## Symptom

The live DSH at `http://127.0.0.1:3080` (served by a manual `pnpm dsh web` out of
`~/github/tali-dash-plugins/deepseek-harness`) was unstable: the browse view went
blank a few seconds after load, and agent turns could not complete. The browser
console showed, repeating:

- dozens of `Failed to load resource: the server responded with a status of 404`
- `Error: renderSlot('root') before any 'root' registration (boot order)` — plugins:17163
- `[cordis-client-runner] syncing inspect providers failed: Error: gateway/cancelled: client api: Remote invocation ...`
- `[cordis-client-runner] syncing inspect providers failed: Error: client api: dynamicCordisRunner/syncInspectMani...`

None of these were bugs in the rebased fork. They were all fallout from the build
being rewritten underneath the running server, over and over.

## Root cause

A previous agent (in the DSH session `deepseek-harness/rebase-deepseek-harness-fork`)
created `/tmp/dsh-promote.sh` to promote the rebased fork into the live DSH, and
registered it with **`launchctl submit`** — i.e. as a job with **no plist on disk**
and, critically, with **`keepalive` set**.

The script itself has no loop. It runs to completion and exits 0. Because the job is
`keepalive`, launchd immediately restarts it. Result: a tight loop, roughly **25
seconds per cycle**, running continuously for about an hour.

Each cycle does:

1. `pnpm install --frozen-lockfile`
2. `pnpm run build` — rewrites `apps/web/dist/` (248 client artifacts)
3. `launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay`

Evidence at the time of diagnosis:

```
$ launchctl list | grep dsh
65609   0   io.github.taliesinb.dsh-promote

$ launchctl print gui/$UID/io.github.taliesinb.dsh-promote
    path = (submitted by launchctl[6746])
    type = Submitted
    runs = 127
    last exit code = 0
    properties = keepalive | inferred program
```

`/tmp/dsh-promote.log` had grown past 1775 lines, with the give-away pattern of a
run starting on the same second the previous one finished:

```
== 22:05:52 pnpm run build
== 22:06:16 restarting live relay (kills the running dsh web)
== 22:06:16 HEAD fc37f1312f (feat/embed-session)    <- next run, immediately
== 22:06:41 pnpm run build
```

### Why each symptom followed

- **404s / blank page** — the page was loading while `apps/web/dist/` was mid-rewrite.
  Hashed asset names change every build, so an `index.html` from cycle N asks for
  chunks that cycle N+1 has already replaced.
- **`renderSlot('root') before any 'root' registration`** — the client booted against a
  mutually inconsistent set of bundles; the plugin that registers the `root` slot was
  one of the chunks that 404'd, so the slot was rendered before its registration ran.
- **`cordis-client-runner` sync failures** — same cause, server side of it: the
  in-flight client/server pair did not agree.
- **Turns not completing** — `tsc -b` plus `tsdown` were pegging a core permanently
  (the build process was observed at 103% CPU), competing with the live server.

Note that **step 3 was failing harmlessly the whole time**. `/tmp/dsh-promote.err` is
24 identical lines of:

```
Could not find service "io.github.taliesinb.dsh-web-relay" in domain for user gui: 501
```

So the loop was never actually killing the manual `dsh web`. The damage was purely
the asset churn and the CPU load.

## The fix

```
launchctl remove io.github.taliesinb.dsh-promote
```

Then one clean build, because the loop was killed mid-build and left
`apps/web/dist/` in a torn state:

```
cd ~/github/tali-dash-plugins/deepseek-harness && pnpm run build
```

Verified after the fix: no `dsh-promote` in `launchctl list`, zero `tsdown` /
`scripts/build.ts` processes, `pnpm run build` exits 0 and records 248 client
artifacts, and the server answers `303 See Other` with a `dsh-auth-*` cookie when
given the token (401 without it). The manual `pnpm dsh web` (pid 62121) survived
throughout and did not need restarting.

## Still open

1. **`io.github.taliesinb.dsh-web-relay` does not exist on this machine.**
   `~/Library/LaunchAgents/io.github.taliesinb.dsh-web-relay.plist` is present (dated
   2026-09-18) but the job is not loaded, which is why every `kickstart` returned 501.
   The promote flow could never have worked as designed. Either load the plist or
   rewrite the promote script to restart whatever is actually serving :3080.
2. **The rebased fork has not been re-examined on a clean build.** Every console error
   in the original report is explained by the loop, but that is an inference, not a
   verification. Someone should reload the page now that the churn is gone and confirm
   the console is clean — in particular that the `renderSlot('root')` boot-order error
   and the `cordis-client-runner` inspect-provider sync are both gone. The submodule is
   at `fc37f1312f` (`feat/embed-session`, on upstream `dsh-v0.1.6-alpha.2`); the
   superproject pins it in `ea87c7a`.
3. **`/tmp/dsh-promote.sh` is still on disk** and is still `keepalive`-shaped, in that
   it exits 0 after a single pass. If it is resubmitted, submit it *without* keepalive,
   or give it a real plist with `RunAtLoad` and no `KeepAlive`.

## Lesson for the next agent

Do not `launchctl submit` a one-shot promote/build script. `launchctl submit` defaults
to keepalive, and a script that exits 0 then becomes an infinite rebuild loop against
the tree a live server is serving from. Use a plist with `RunAtLoad=true` and
`KeepAlive=false`, or just run the script in the foreground.

---

# Second, unrelated bug: every tool call failed (2026-09-20, later)

Status: **root-caused and fixed.** This is a *different* fault from the promote
loop above. Stopping the loop did not fix it; it was only hidden by it.

## Symptom

Every turn died the instant the model emitted its first tool call:

```
This turn failed   Cannot read properties of undefined (reading 'prepare')
```

The UI otherwise behaved — no blanking, no 404s. From inside a session the model
observed "Tools keep returning no result, so something might be broken with the
tool pipeline or bridge itself."

## Evidence

The failure is recorded in the session log. Turn 12 of
`~/.dsh/sessions/--Users-tali-projects-deepseek-harness--/session-1a3ac1aa-.../session.v3.jsonl.zstd`:

```
{"type":"tool/call","seq":1533,...,"name":"read",...}
{"type":"step/end","seq":1534,...}
{"type":"turn/end","seq":1535,...,"reason":{"kind":"error",
  "error":{"message":"Cannot read properties of undefined (reading 'prepare')"}}}
```

`tool/call` is appended, then it dies before dispatch. That pins the throw to
`packages/core/agent-loop/src/tool-calls.ts`, in `startCall`:

```ts
callSeqs[index] = appendToolCall(session, turn, step, call.block)   // appended
started++
const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)  // throws
```

So `ctx.tools[TOOL_RUNTIME_SCHEDULER]` was `undefined`.

## Root cause: two copies of `@deepseek-ai/dsh-tools`, two distinct symbols

The scheduler handle is keyed by a **module-local** symbol
(`packages/core/tools/src/index.ts:463`):

```ts
export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('@deepseek-ai/dsh-tools.scheduler')
```

`Symbol()` is identity-based, not name-based. Load the module twice and you get two
symbols that print identically and match nothing across the boundary. Confirmed
directly:

```
src symbol desc = @deepseek-ai/dsh-tools.scheduler
lib symbol desc = @deepseek-ai/dsh-tools.scheduler
SAME INSTANCE?  false
is Symbol.for?  false
```

And the live server really does load it twice. Probing the running process (a
`console.error` at the top of each build) printed **both**:

```
[PROBE] SRC tools loaded: .../packages/core/tools/src/index.ts
[PROBE] LIB tools loaded: .../packages/core/tools/lib/index.js
```

A resolve-hook trace narrowed the second load to exactly one importer. Every other
consumer — `dsh-agent-loop`, `cordis-host-runner`, `mcp-client`, and all seven
tali plugins — resolves to **src**. Only this one resolves to **lib**:

```
[RESOLVE LIB] spec=@deepseek-ai/dsh-tools
            parent=apps/cli/node_modules/@deepseek-ai/dsh-agent-instructions/package.json
```

The mechanism: the server runs from TypeScript source under tsx, and
`tsconfig.base.json:484` maps `@deepseek-ai/dsh-tools` → `./packages/core/tools/src`.
That alias is what keeps everyone on one copy. But the parent here is a
**`package.json` inside `node_modules`** — the cordis bundle loader resolving a
plugin dependency by package name. tsconfig `paths` do not apply on that route, so
Node falls back to the package's own `exports`, which point at the built
`lib/index.js`.

Result: cordis constructs the `tools` service from the **lib** `ToolRuntime` class,
so `ctx.tools` carries the lib symbol; `agent-loop` reads the **src** symbol; the
lookup returns `undefined`; every tool call dies.

This is why it looked like "the harness is broken" rather than "one plugin is
broken" — the scheduler is the single chokepoint all tool calls pass through.

## The fix

One line, `packages/core/tools/src/index.ts:463`:

```diff
-export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('@deepseek-ai/dsh-tools.scheduler')
+export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol.for('@deepseek-ai/dsh-tools.scheduler')
```

`Symbol.for` interns in the cross-realm registry, so both copies agree on the key
regardless of how many times the module is loaded. Verified:

```
SAME SYMBOL NOW?                  true
lib-instance[srcSymbol] defined?  true
classes distinct (still 2 copies)? true
```

Then `pnpm run build` (exit 0, 248 client artifacts).

### Verified end to end

A test server on port 3099 with the fix, driven through CDP: the UI booted with a
**clean console** (no `renderSlot('root')`, no `cordis-client-runner` errors), and a
prompt that forces a tool call — "Read /Users/USER/.../PROMOTION-LOOP.md and reply
with only its first heading" — completed in 8s, `1 tool call`, returning the correct
heading. Before the fix this exact shape of turn died immediately.

## Caveats for whoever picks this up

1. **This treats the symptom, not the duplication.** Two copies of `dsh-tools` are
   still loaded, so there are still two `ToolRuntime` classes, two module states, and
   two of every other module-local value in that package. `Symbol.for` only rescues
   this one key. Any other cross-copy identity check in `dsh-tools` — `instanceof`, a
   `WeakMap` keyed by class, another bare `Symbol()` — is still broken and will
   surface as its own mystery. The real fix is to stop `dsh-agent-instructions` from
   resolving the package through `node_modules`/`exports`.
2. **It is a fork-local edit to upstream source.** `packages/core/tools/src/index.ts`
   is upstream DSH code, so this will need re-applying or re-deciding on the next
   rebase. Consider adding it to the rebase recipe.
3. **Timing.** This did not start with the rebase in any way I confirmed. It may
   predate it. I did not bisect.
4. `lib/` is gitignored build output, so the fix only travels via the `src` edit plus
   a build.
