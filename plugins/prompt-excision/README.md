# Provider-scoped prompt excision

Host-only, out-of-tree DSH plugin that removes whole paragraphs from the assembled initial system prompt when they contain configured literal strings. It does not replace the prompt with a different identity or certify any billing outcome.

## Configuration

The generic implementation has no implicit rules. The opt-in [bundle patch](cordis.patch.yml) supplies this deployment mapping:

```yaml
- insert:
    - id: tali-prompt-excision
      name: tali-prompt-excision
      config:
        providers:
          anthropic-oauth:
            - DeepSeek Harness
```

`providers` maps exact provider route ids to lists of literal strings. A paragraph matching **any** string is removed. Matching is case-sensitive and uses substring inclusion, not regular expressions or word boundaries. There is no wildcard, alias conversion, credential-flow-name matching, or automatic targeting of other OAuth providers. The route is `anthropic-oauth`, not `anthropic-auth` or the public flow name `anthropic`.

An empty mapping or empty list disables removal. Unknown configuration keys, invalid mappings, and empty/whitespace-only strings fail activation. Changing an installed row's configuration replaces its entire config, not individual nested fields.

To override an already installed bundle, use a normal profile override, **without** another insert:

```yaml
- id: tali-prompt-excision
  config:
    providers:
      anthropic-oauth:
        - DeepSeek Harness
```

## Exact behavior

- A paragraph is a run of text separated by blank lines. LF and CRLF are supported; blank lines may contain spaces or tabs. Wrapped lines belong to the same paragraph.
- This is a plain-text operation, not a Markdown parser. Contiguous list items or fenced content can be part of one paragraph. A match removes the entire paragraph, including instructions that do not themselves contain the marker.
- Sections are rendered with DSH's own strict variable interpolator before matching. Changed sections become non-interpolating literal text, so substituted brace sequences are not interpreted a second time. Invalid template references still fail normally.
- Unmatched paragraph text remains byte-identical. Separators adjacent to removed paragraphs are discarded as needed; surviving paragraphs retain their preceding original separator. Unaffected sections and no-op assemblies retain their original objects.
- All matching paragraphs are removed, not only a hardcoded list of three. Fully removed sections disappear. An entirely removed initial prompt produces no DSH system section.
- User/assistant messages, runtime-context snapshots, tool schemas/descriptions, variables, source files, and stored historical events are not edited. No prompt contents are logged by this plugin.

The bundled rule removes the normal identity paragraph, the implementation-checkout paragraph, and the Web GUI paragraph that contain `DeepSeek Harness`. This also removes their operational guidance: the implementation path, GUI URL, and related instructions are no longer in that initial prompt. This is deliberate whole-paragraph deletion, not a branding-only substitution.

## Timing and scope

The plugin joins `system-prompt/assemble` with `prepend: true`, delegates to the rest of the waterfall, then uses the returned assembly's `variables.provider`. This sees the normal UI model-selection override rather than stale agent creation options. Each subsequent assembly uses the current mapping and provider; unloading the plugin restores normal assembly on later requests.

DSH's normal prompt admission subsequently records the transformed text in `system/message` events and sends it to the model. Excision is not a hidden `llm/stream` or HTTP-body rewrite. Historical events remain intact; the plugin is not a retrospective log scrubber.

pi-ai applies its OAuth-specific identity block **after** this stage. The plugin does not remove or duplicate `You are Claude Code, Anthropic's official CLI for Claude.`, change tool casing, alter HTTP attribution, inspect credentials, or change authentication. See the separate [OAuth audit/observation plugin](../anthropic-oauth-audit/README.md) for billing-route evidence; prompt excision is not evidence of subscription coverage or zero charges.

## Limitations

- DSH restores a `complete: true` verbatim persona after the assembly waterfall. Such personas take precedence and are intentionally exempt. Author an already-filtered complete persona or use ordinary sections when excision is required. The normal three target paragraphs use ordinary assembly.
- A plugin changing only the later `agent/request` route cannot retroactively change which rule ran. Such a router must also expose its selected provider during prompt assembly, as DSH's normal model-selection integration does.
- A later outer waterfall transformation can reintroduce text. Direct LLM calls that bypass system-prompt assembly, such as independently authored auxiliary prompts, are outside this plugin's scope.
- It only removes matching initial-system paragraphs. Matching text elsewhere in the request remains; it is not a general request anonymizer.

## Install deliberately

No live profile or global plugin roster is changed by developing this plugin. Obtain explicit approval before installing it in a running or next-launch DSH configuration.

With the DSH checkout installed/built, prepare this plugin's local renderer dependency from its directory:

```sh
pnpm install --offline --ignore-scripts --lockfile=false
```

Then, **only for an approved target home/profile**, run from the DSH checkout:

```sh
pnpm dsh plugin --profile web add ../plugins/prompt-excision
```

Installing the bundle opts into the mapping above and can apply immediately on a live profile. Do not also insert the same plugin through a dev overlay. No browser bundle or DSH rebuild is required for the plugin itself; subsequent host source edits require the normal safe restart procedure.

## Tests

From this plugin directory:

```sh
pnpm run check
```

From the installed DSH checkout, without changing its build artifacts:

```sh
node --import tsx/esm --test ../plugins/prompt-excision/tests/integration.mjs
```

Unit tests pin the paragraph algorithm, literal matching, template handling, mapping validation, and no-op/reference preservation. Real Loader/Include tests mount the core Agent loop and verify transformed requests against replay from copied session events, route switching, disposal, and the documented complete-persona/late-route limits. An additional real pi-ai serialization test uses dummy in-memory credentials and intercepted HTTP to confirm the native OAuth identity remains and ordinary API-key prompts are untouched. Tests make no real inference calls and read no live credentials.

System-level rationale and source locations: [recipe](../../recipes/provider-scoped-prompt-excision.md).
