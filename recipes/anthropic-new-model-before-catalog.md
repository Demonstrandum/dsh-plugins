# Recipe: adding a just-released Anthropic model before the pi-ai catalog ships it

Reproducible steps to make a newly released Anthropic model selectable in the
DSH model picker while the installed `@earendil-works/pi-ai` catalog still
lags it. Done twice so far:

- **Claude Fable 5.1** (released 2026-09-01) — verified 2026-09-03 against
  pi-ai 0.84.2. The worked example below.
- **Claude Opus 5.5** (released 2026-09-22) — done 2026-09-23 against pi-ai
  0.85.1 (the checkout's pin), which by then shipped `claude-fable-5-1` itself
  but not `claude-opus-5-5`; pi-ai ships that from **0.87.1**. See
  "Second round" at the end for what differed.

## How it works (and why the model was missing)

The model selector for a **catalog provider** (`anthropic`, `openai`, …) is
answered from the *installed pi-ai catalog*, never from the network —
`packages/llm/llm-pi-ai/src/discovery.ts` is explicit: a catalog route is
answered "from that catalog, with no network call at all". So a model released
yesterday cannot appear until either:

1. a pi-ai release ships it (checked: 0.84.2 installed *and* latest published
   0.84.4 both top out at `claude-fable-5`), or
2. the deployment declares it in `settings.yaml` — the supported escape hatch;
   `catalog.ts` documents that the route `api` fallback exists precisely so "a
   deployment [can] add a model the installed catalog has not caught up with —
   a provider's newest release".

This recipe uses (2). Resolution order per model entry: configured fields →
installed catalog entry of the same id → route defaults
(`resolveRouteModels` in `packages/llm/llm-pi-ai/src/catalog.ts`).

## 1. Get the real model spec (don't guess)

The Anthropic listing endpoint needs a key in the shell (`ANTHROPIC_API_KEY`
was not in the agent env), but [models.dev](https://models.dev/api.json)
carries the same registry. For `claude-fable-5-1` it reports:

- id `claude-fable-5-1` (dashes, like every Anthropic alias), name "Claude Fable 5.1"
- context 1,000,000 / output 128,000
- input: text, image (+pdf, which DSH's modality set does not model)
- reasoning efforts `low, medium, high, xhigh, max` — **no `off`**: adaptive
  thinking cannot be disabled, same as `claude-fable-5`

Also dump the sibling catalog entry to mirror its compat switches:

```bash
cd <dsh-checkout>/packages/llm/llm-pi-ai && node -e "
import('@earendil-works/pi-ai/providers/all').then(({getBuiltinModels}) =>
  console.log(JSON.stringify(getBuiltinModels('anthropic').find(m=>m.id==='claude-fable-5'),null,2)))"
```

→ `claude-fable-5` carries `compat: { forceAdaptiveThinking: true,
supportsStrictTools: true }` and `thinkingLevelMap: { off: null, xhigh:
"xhigh", max: "max" }` on `anthropic-messages`.

## 2. settings.yaml change

Under `llm-pi-ai.providers.anthropic` in `~/.dsh/settings.yaml`. **Caveat
that shapes the whole edit**: a `models` list *replaces* the served catalog
(`modelOverrides` cannot add ids — it refuses unknown ones). So every shipped
model that should stay in the picker is restated as a bare id; a bare id
inherits its full installed-catalog entry (capacities, reasoning map, compat)
via the `...base` spread in `resolveRouteModels`.

```yaml
llm-pi-ai:
  providers:
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY
      models:
        - id: claude-fable-5-1
          name: Claude Fable 5.1
          contextWindow: 1000000
          maxTokens: 128000
          input: [text, image]
          # Adaptive thinking like fable-5: no "off" level, efforts low..max.
          reasoningEfforts:
            low: low
            medium: medium
            high: high
            xhigh: xhigh
            max: max
          compat:
            forceAdaptiveThinking: true
            supportsStrictTools: true
        - id: claude-fable-5            # bare ids inherit the installed
        - id: claude-haiku-4-5          # catalog entries unchanged
        - id: claude-haiku-4-5-20251001
        - id: claude-opus-4-5
        - id: claude-opus-4-5-20251101
        - id: claude-opus-4-6
        - id: claude-opus-4-7
        - id: claude-opus-4-8
        - id: claude-opus-5
        - id: claude-sonnet-4-5
        - id: claude-sonnet-4-5-20250929
        - id: claude-sonnet-4-6
        - id: claude-sonnet-5
```

No restart: the settings file provider watches the document and llm-pi-ai
re-registers the route live; reopen the model picker (refresh if needed).

### Field semantics worth knowing

- **`api`/`baseURL` are omitted deliberately.** The unknown id resolves its
  protocol through `sharedCatalogApi` — every shipped anthropic model speaks
  `anthropic-messages`, so the new entry adopts it — and the endpoint comes
  from the catalog provider (`https://api.anthropic.com`).
- **`reasoningEfforts` pins undeclared levels to unsupported.** DSH translates
  the dict to a full `thinkingLevelMap` with every undeclared level explicitly
  `null`, because pi-ai's own defaulting is asymmetric (absent = supported for
  the five base levels, unsupported for `xhigh`/`max`). Omitting `off` is what
  encodes "adaptive thinking, cannot be turned off" — do **not** write
  `off:` with no value (that means "supported, send nothing") and an empty
  `reasoningEfforts:` is refused outright.
- **Configuring `maxTokens` also makes it the per-request default cap** (a
  catalog-inherited value never does). Here 128000 equals the capability, so
  it is harmless — but don't reflexively copy capacities onto bare-id entries,
  or you turn capabilities into request defaults.
- **`compat` keys are gated.** Only fields the `anthropic-messages` gate
  offers may be set (`forceAdaptiveThinking`, `supportsStrictTools`, etc.);
  anything else fails route resolution loudly, naming the key.
- **Cost shows as zero** for a hand-declared model (`NO_COST`); DSH never
  reads pi-ai cost metadata, so nothing is lost.

## 3. Verify through DSH's own resolution path

Don't trust the YAML by eye — run it through the exact function the selector
uses (Node 26 strips types natively):

```bash
cd <dsh-checkout>/packages/llm/llm-pi-ai && node --experimental-strip-types -e "
const { resolveRouteModels } = await import('./src/catalog.ts')
const { load } = await import('js-yaml')
const { readFileSync } = await import('node:fs')
const settings = load(readFileSync(process.env.HOME + '/.dsh/settings.yaml','utf8'))
const { models } = resolveRouteModels({
  provider: 'anthropic',
  models: settings['llm-pi-ai'].providers.anthropic.models,
  defaultContextWindow: 128000, defaultMaxTokens: 8192, defaultInput: ['text'],
})
console.log(models.length, 'models')
console.log(JSON.stringify(models.find(m => m.id === 'claude-fable-5-1'), null, 1))"
```

Checked on 2026-09-03: 14 models resolve; `claude-fable-5-1` materializes with
`api: anthropic-messages`, `baseUrl: https://api.anthropic.com`, the full
pinned `thinkingLevelMap`, and the fable-5 compat block; the bare-id
`claude-fable-5` still inherits its catalog `thinkingLevelMap`/compat intact.
(`import('yaml')` is not resolvable from that package — use `js-yaml`.)

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| New model absent from the picker after a provider "refresh" | Expected — discovery answers catalog routes from the installed catalog; only `settings.yaml` (or a pi-ai upgrade) changes the list |
| Route fails: `model "…" needs an api` | The route's shipped models don't share one protocol (not the case for anthropic) or the id is on a non-catalog route — set `api` on the route |
| Route fails: `modelOverrides names "…", which the installed catalog does not describe` | `modelOverrides` customizes existing ids only; a *new* id needs the `models` list |
| Other Anthropic models vanished from the picker | The `models` list replaced the catalog — restate them as bare ids (step 2) |
| Route fails: `empty reasoningEfforts` / `needs the wire value` | Empty dict or valueless level; declare levels with wire spellings, only `off` may be valueless |
| Requests send a thinking level the API rejects | Wire spellings wrong — mirror the provider's published effort values, not DSH level names |

## Cleanup / future

- The block is temporary scaffolding: once a pi-ai release ships
  `claude-fable-5-1` **and DSH's checkout upgrades past `^0.84.2`**, delete the
  entire `models` list to return to serving the installed catalog unchanged
  (the catalog entry will also carry real cost/compat data).
- Watch for drift while the override lives: if Anthropic revises limits or
  effort levels, models.dev is the quickest registry to re-check.
- `agent-default-model` in the same file still points at `claude-fable-5`;
  switch it to `claude-fable-5-1` to make new sessions default to it.
- Same recipe applies to any catalog provider (OpenAI, etc.) — only the
  restated id list and the compat gate fields differ per protocol.

## Second round (2026-09-23): Claude Opus 5.5 on pi-ai 0.85.1

What was different the second time, in the order it mattered:

1. **Check what the installed catalog already has before touching anything.**
   The checkout had moved to pi-ai `^0.85.1`, whose catalog *does* ship
   `claude-fable-5-1` (with `supportsMidConvoEffort: true` on top of what the
   hand-written block declared). So the Fable 5.1 override was demoted to a
   bare id and only the genuinely missing model got a full entry. List ids
   with:

   ```bash
   cd <dsh-checkout>/packages/llm/llm-pi-ai && node -e "
   import('@earendil-works/pi-ai/providers/all').then(({getBuiltinModels}) =>
     console.log(getBuiltinModels('anthropic').map(m=>m.id).join('\n')))"
   grep '"version"' node_modules/@earendil-works/pi-ai/package.json   # the pin (0.85.1)
   ```

2. **Get the spec from the newest published pi-ai, not only models.dev.**
   `npm view @earendil-works/pi-ai time --json | tail` showed 0.87.1
   (2026-09-22); `npm pack @earendil-works/pi-ai@0.87.1` and read
   `package/dist/providers/data/anthropic.json` (shape:
   `{ "anthropic-messages": { "<id>": Model } }`). It carries the exact
   `thinkingLevelMap` and `compat` the maintainers chose, which models.dev
   does not (models.dev showed `reasoning_options` low..max and a `fast`
   mode — DSH has no notion of the latter). "Opus 5.5 max" is the `max`
   effort of `claude-opus-5-5`, not a separate model id; 0.87.1 lists no
   `-max` variant anywhere.

3. **Compat keys drift between pi-ai versions — mirror only what the
   installed gate offers.** 0.87.1's entry has
   `supportsMidConvoEffort`, `supportsMidConvoSystemMessages`,
   `supportsMidConvoToolChanges`, `forceAdaptiveThinking`,
   `supportsTemperature: false`, `supportsStrictTools`. In 0.85.1's
   `AnthropicMessagesCompat` the two `supportsMidConvo*Messages/ToolChanges`
   keys do not exist and `supportsMidConvoEffort` is `'withhold'` in
   `ANTHROPIC_COMPAT_GATE` (`catalog.ts`), so any of them fails route
   resolution loudly. Offered keys as of 0.85.1: `supportsEagerToolInputStreaming`,
   `supportsLongCacheRetention`, `supportsCacheControlOnTools`,
   `supportsTemperature`, `forceAdaptiveThinking`, `allowEmptySignature`,
   `supportsStrictTools`. The block written:

   ```yaml
   - id: claude-opus-5-5
     name: Claude Opus 5.5
     contextWindow: 1000000
     maxTokens: 128000
     input: [ text, image ]
     reasoningEfforts: { low: low, medium: medium, high: high, xhigh: xhigh, max: max }
     compat:
       forceAdaptiveThinking: true
       supportsStrictTools: true
       supportsTemperature: false
   - id: claude-fable-5-1     # now a bare id: inherits the 0.85.1 catalog entry
   ```

   The resulting `thinkingLevelMap` (`off: null, minimal: null, low..max`) is
   byte-identical to 0.87.1's shipped entry.

4. **Validate the candidate on a copy, then copy it over the live file.**
   Besides the `resolveRouteModels` check in step 3 above, run the whole
   section through the plugin's own schema and the strict check the settings
   writer applies (`Config` is a schemastery validator — construct it, there
   is no `.parse`):

   ```bash
   cd <dsh-checkout>/packages/llm/llm-pi-ai && node --experimental-strip-types -e "
   const { Config, assertServiceable } = await import('./src/config.ts')
   const { load } = await import('js-yaml'); const { readFileSync } = await import('node:fs')
   const s = load(readFileSync('/tmp/settings.candidate.yaml','utf8'))
   assertServiceable(new Config(s['llm-pi-ai'])); console.log('ok')"
   ```

   Then `cp /tmp/settings.candidate.yaml ~/.dsh/settings.yaml` (keep a
   backup). The route re-registered live; the new model was in the picker of
   a freshly opened GUI tab with no restart and no page reload.

5. **Verification trap: the composer's model picker writes
   `agent-default-model`.** Selecting the new model in a *New Session*
   composer to inspect its effort menu persisted `model: claude-opus-5-5` to
   `settings.yaml` server-side — it is not a per-tab preference. Switch it
   back through the same picker (or edit the file) if you only meant to look.
   The effort menu for Opus 5.5 showed Default / Low / Medium / High / Xhigh /
   Max and no Off, as intended.

6. **Alternative not taken: bumping the checkout's pi-ai to `^0.87.1`.** That
   would serve the catalog natively (with real cost data) but is a fork
   dependency change (package.json + lockfile), needs a typecheck against a
   two-minor-version jump (new compat keys mean the drift gates in
   `catalog.ts` must be reclassified — that is exactly what they are for),
   and a live `dsh web` restart. The settings escape hatch is the zero-restart
   path; revisit the bump when the fork is next rebased/upgraded, and delete
   the whole `models` list at that point.

7. Also new that day, not done: OpenAI `gpt-6-luna` / `gpt-6-sol`
   (2026-09-22). The same recipe applies, but the openai route has ~40 shipped
   ids to restate as bare ids and its own `RESPONSES_COMPAT_GATE`.
