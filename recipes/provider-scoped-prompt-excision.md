# Provider-scoped initial-system-prompt excision

## Purpose and scope

The standalone [prompt-excision plugin](../plugins/prompt-excision/README.md) removes entire initial-system paragraphs containing configured literal strings for selected provider routes. Its opt-in bundle maps `anthropic-oauth` to the exact, case-sensitive string `DeepSeek Harness`. There is no fork patch, global provider change, or live installation in this change.

The mapping belongs in the plugin's [bundle patch](../plugins/prompt-excision/cordis.patch.yml), with deployment overrides in the target profile. The [implementation](../plugins/prompt-excision/excision.mjs) is provider-agnostic; it has no implicit Anthropic or branding rules. `anthropic-auth` is not an alias: the existing OAuth route is `anthropic-oauth`, while `/oauth activate anthropic` uses the public flow name.

## Where the three paragraphs originate

All three stock paragraphs are contributed by the DSH checkout, rather than the out-of-tree billing observer:

1. [System-prompt identity](../deepseek-harness/packages/core/system-prompt/src/index.ts): `You are an AI agent powered by DeepSeek Harness.`
2. [App-boot source-checkout contribution](../deepseek-harness/packages/boot/app-boot/src/index.ts#L1009): the implementation-checkout paragraph, including the instructions distinguishing the checkout from the working directory.
3. [Web-app runtime contribution](../deepseek-harness/packages/bundle/web-app/src/index.ts#L139): the Web GUI paragraph, including its URL, rebuild guidance, and prohibition on starting an unsolicited replacement server.

The rule deletes the **whole** paragraph. It therefore deletes those operational instructions too, not just the harness name. Other paragraphs containing the same literal are removed as well; the plugin does not encode three special section names.

## Why use the assembly waterfall

DSH [renders and admits the system prompt before dispatch](../deepseek-harness/packages/core/agent-loop/src/agent.ts#L359-L372). Rewriting only the pi-ai HTTP body would leave the trajectory describing a different prompt. This plugin instead delegates through `system-prompt/assemble`, uses the returned provider selection, renders sections with the existing DSH interpolator, then excises matching paragraphs before ordinary prompt admission records `system/message` events.

The listener uses `prepend: true` so it observes the normal [model-selection override](../deepseek-harness/packages/core/agent/src/model-selection.ts#L76-L88) after downstream assembly. It transforms copies of changed sections, leaving tools, contexts, variables, and untouched sections alone. It never rewrites stored history, user text, assistant messages, or tool schemas. The [README](../plugins/prompt-excision/README.md#exact-behavior) defines blank-line splitting and the consequences for wrapped lines and Markdown.

Two limitations are deliberate and tested: DSH's `complete: true` verbatim persona is restored after the assembly waterfall and takes precedence; a custom route change made only in the later `agent/request` waterfall must also publish its provider during assembly for this rule to follow it. Independently authored LLM calls that bypass assembly are outside this plugin's scope.

## Relationship to OAuth transport and billing

pi-ai's native OAuth transport still prepends `You are Claude Code, Anthropic's official CLI for Claude.` after DSH prompt admission. Excision does not add, remove, or emulate that block and does not alter authentication, the mandatory DSH HTTP attribution, or reversible tool casing. Ordinary API-key routes retain their original prompt.

Removing branding paragraphs is not evidence that a request is included in subscription allowance, free of extra usage, or permitted by a provider. Keep it separate from the [billing observation/audit facility](anthropic-oauth-audit.md). Observation can report future response headers; neither plugin turns those headers into an invoice or retroactively determines old requests' billing.

## Reproduce and deploy deliberately

The [plugin README](../plugins/prompt-excision/README.md#install-deliberately) owns configuration and installation commands. The new package needs only its existing local DSH renderer dependency; dependency preparation is confined to the new plugin directory. It is not added to the general installer roster or the active dev overlay.

From the plugin directory:

```sh
pnpm install --offline --ignore-scripts --lockfile=false
pnpm run check
```

From the installed DSH checkout:

```sh
node --import tsx/esm --test ../plugins/prompt-excision/tests/integration.mjs
```

The unit suite pins paragraph removal and exact outputs. The real Loader/Include suite mounts the Agent loop, captures admitted requests and copied session events, and verifies replay yields the same messages. It covers provider switches, no-op object preservation, disposal, complete personas, and late-route behavior. An additional real pi-ai serialization fixture verifies the native OAuth identity and excised second system block, untouched user/runtime/tool content, and unchanged API-key prompts. Credentials and HTTP responses are synthetic; no live credentials or real inference are used.

For live use, obtain explicit approval for the destination instance, install this bundle with its desired provider mapping, and verify the next ordinary request's admitted system prompt. Installing a bundle may apply immediately. Do not install it into a live profile, edit that profile, or restart an app merely to complete development tests. Source changes to an already installed host module require a safe restart; no browser bundle or shared DSH rebuild is needed.

## Troubleshooting

| Symptom | Explanation / action |
|---|---|
| `anthropic-auth` or `anthropic` does not trigger excision | Rules use exact provider routes. The OAuth route is `anthropic-oauth`; the public login flow is named `anthropic`. |
| A wrapped paragraph is only partly removed by an attempted implementation | Removing matching lines is insufficient. The final algorithm splits on blank lines and removes the entire matching paragraph, including unbranded continuation lines. |
| A marker supplied through a variable is missed | Match after DSH interpolation, then set changed sections to `interpolate: false` so surviving substituted braces are not expanded again. |
| Excision follows the previous selected model | Inspect the returned assembly after `await next()`, not the incoming assembly or old request header. |
| A complete persona retains the marker | Core deliberately restores `complete: true` sections after the waterfall. Author the desired complete text directly or use ordinary sections. |
| Text remains in a user message, runtime context, or tool description | Intended: the rule targets initial-system sections only. It is not a global request anonymizer. |
| An old trajectory event still contains the original paragraph | Historical events are not erased. Inspect the newly admitted system prompt and its active surface. |
| Real composition has optional pending injector fibers | Only mandatory fixture services must be active; core's optional settings injectors may legitimately be pending. Do not weaken checks on the plugin itself. |
