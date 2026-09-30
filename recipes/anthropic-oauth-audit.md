# Anthropic OAuth request and routing audit

## Goal and findings

Compare the existing DSH OAuth route with Rho's Anthropic integration and expose request/response evidence without claiming to know the provider's settled billing.

Rho's billing display is split between its footer and header watcher, not a standalone billing verifier. The inspected sources at [the public upstream revision](https://github.com/Demonstrandum/rho/tree/ce8d86fcd004da07ebf1137060b92663cd801710) contain:

- [Prompt defingerprinting](https://github.com/Demonstrandum/rho/blob/ce8d86fcd004da07ebf1137060b92663cd801710/extensions/prompt-defingerprint.ts#L13-L24): rewrites three Pi-specific documentation instruction lines. These are not DSH's prompt instructions; copying the regexes into DSH would not establish anything about its classification.
- [Prompt style cleanup](https://github.com/Demonstrandum/rho/blob/ce8d86fcd004da07ebf1137060b92663cd801710/extensions/prompt-disenshittify.ts): a general prompt house-style transform, not a billing verifier. It runs before the transport adds the Claude identity block. It is not ported.
- [Extra-usage watcher](https://github.com/Demonstrandum/rho/blob/ce8d86fcd004da07ebf1137060b92663cd801710/extensions/extra-usage-watch.ts#L11-L65): observes `anthropic-ratelimit-unified-*` headers. It considers `five_hour` and `seven_day` representative claims plan evidence, warns about other claims, and watches aggregate overage utilization. Unknown claims and non-plan 429s cannot safely establish billed overage. Its warning-clearing behavior can also erase an aggregate-increase warning immediately after raising it; this behavior is not copied.

- [Footer](https://github.com/Demonstrandum/rho/blob/ce8d86fcd004da07ebf1137060b92663cd801710/extensions/footer.ts#L119-L141): adds `(sub)` when the currently selected model uses OAuth, and displays token-cost estimates separately. This suffix is an authentication-mode label, not header evidence or a measured billed amount. Session-wide estimates can cover multiple models; the suffix describes the current selection.
Rho's investigation notes record historical accepted/rejected requests and header observations, with same-day classifier changes and utilization confounding. They do not reconcile invoices or account ledgers. OAuth acceptance, HTTP 200, CLI-like request formatting, plan-window limiter claims, and confirmed seat billing are different facts. Subscription extra usage and platform API billing are also different funding paths.

The inspected DSH fork's `anthropic-oauth` route is implemented in the in-tree `llm-pi-ai` and authorization plugins, not one of the public out-of-tree plugins. The audit implementation originally left existing OAuth edits untouched; the subsequent [OAuth naming change](oauth-flow-names-and-routes.md) generalizes isolated routes and renames the command package without changing this audit's selected provider id. The route's pi-ai 0.87.1 dependency already implements:

1. OAuth login/refresh and Bearer access tokens, separately from the API-key provider route.
2. The first system block `You are Claude Code, Anthropic's official CLI for Claude.`, **followed by** the original DSH system text in another block. It prepends the identity, rather than replacing the DSH prompt.
3. OAuth/Claude Code beta flags and `x-app: cli`.
4. Reversible canonical casing for known tool names; custom names remain custom.

This prefix-and-preserve behavior is present in the installed pi-ai 0.87.1 transport; [upstream source for that version](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/api/anthropic-messages.ts) owns its implementation. DSH's trajectory contains pre-transport context, so seeing DSH's identity there does not mean the CLI prefix is absent on the wire. The source comment describes the prefix as required, but neither that comment nor Rho's historical experiments establishes it as a currently necessary or sufficient server-side billing condition.
One concrete difference is DSH's [request header merger](../deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts), which overwrites pi-ai's CLI User-Agent with DSH's [mandatory attribution](../deepseek-harness/packages/llm/llm/src/attribution.ts). Audit mode prefixes a configured CLI token while preserving DSH attribution; passive observation deliberately leaves the original DSH User-Agent alone. No claim is made that the combined value is an exact official-client replica or that this header caused any observed billing behavior.

A referenced existing session was confirmed to select the dedicated OAuth route and complete a greeting, but its transcript did not record HTTP response headers. That old turn therefore cannot be retrospectively verified with this method. No real credentials were read and no live Anthropic calls were made during this change.

## Implementation

[Plugin README](../plugins/anthropic-oauth-audit/README.md) owns configuration, status meanings, limitations, and tests. The implementation is entirely under [the plugin entry](../plugins/anthropic-oauth-audit/index.js), [scoped transport](../plugins/anthropic-oauth-audit/transport.mjs), [evidence classifier](../plugins/anthropic-oauth-audit/evidence.mjs), and [billing report](../plugins/anthropic-oauth-audit/billing.mjs). No fork changes or live configuration edits are needed to develop it.

The current DSH adapter does not expose pi-ai's transport callbacks to sibling plugins, so the plugin uses the public `llm/stream` event plus a reversible, asynchronous-context-scoped fetch wrapper. Audit mode checks serialized requests; both modes classify response headers. Observe mode never reads request bodies. Neither mode sends a tiny probe with an unrelated prompt. A future adapter transport-observation seam could replace the global wrapper; duplicating the entire OAuth provider is not necessary.

The existing audit policy remains the backward-compatible default: preflight violations never dispatch; accepted overage/unknown responses stop with a visible `ANTHROPIC_OAUTH_AUDIT` error. `/oauth-audit` displays the latest retained report for the session, and internal logs contain allowlisted evidence. `onUnverified: warn` preserves accepted output but still repairs headers and blocks preflight violations; it is not passive. Native HTTP/auth/network/cancellation errors stay native. The first request has already been dispatched before any response-based stop: this cannot guarantee zero charges. Provider-side spending controls remain necessary.

For reporting alone, explicitly use `mode: observe`. `/oauth-billing` reports the last response evidence for loaded Anthropic OAuth sessions in this Host; `current` and `recent` narrow to the caller or include retained unloaded sessions. It reports observation time, model, stale state, and utilization rather than dollars or a promise of plan-only coverage. The report is bounded and in-memory; no old HTTP evidence can be recovered from trajectories. The [README](../plugins/anthropic-oauth-audit/README.md#billing-report) owns precise scope and ownership rules.

The command is `/oauth-billing`, not `/oauth billing`: the in-tree OAuth command owns that name and has no subcommand-extension seam. An out-of-tree sibling command avoids shadowing sign-in/logout behavior or patching the fork. A status-bar projection is deferred until this evidence source has been observed on real traffic; it must not turn OAuth authentication or catalog token-cost estimates into a claim about actual charges.
Optional removal of branding paragraphs is a separate [provider-scoped prompt-excision plugin](provider-scoped-prompt-excision.md). It transforms initial-system assembly before logging and does not change this observer's request-preservation policy or provide billing guarantees.
## Reproduce offline

From the plugins checkout:

```sh
node --check plugins/anthropic-oauth-audit/index.js
node --check plugins/anthropic-oauth-audit/transport.mjs
node --check plugins/anthropic-oauth-audit/billing.mjs
node --test plugins/anthropic-oauth-audit/tests/*.test.mjs
```

From its `deepseek-harness/` submodule:

```sh
node --import tsx/esm --test ../plugins/anthropic-oauth-audit/tests/integration.mjs
```

The second command uses a temporary Loader composition, current DSH adapter source, installed pi-ai, a fake credential store, and entirely stubbed HTTP. No settings, credentials, sessions, browser bundle, or running server are changed. It also verifies that ordinary API-key requests retain their original authentication and DSH attribution.

## Roll out deliberately

1. Obtain confirmation before changing the live instance. This implementation has **not** been installed or activated there.
2. Stop the approved target safely before preparing a passive installation. From the DSH checkout, install only this bundle into its intended profile; do not let the instance start or hot-load the default audit policy between installation and configuration:

   ```sh
   pnpm dsh plugin --profile web add ../plugins/anthropic-oauth-audit
   ```

3. Apply the [observe-mode profile override](../plugins/anthropic-oauth-audit/README.md#install-and-configure) before starting it. Restart that instance only when safe; host module edits are not source-hot-reloaded. Retain audit mode only when enforcement and User-Agent repair are explicitly intended.
4. Keep the session on `anthropic-oauth`, not `anthropic`. Send a normal turn only when its possible usage cost is acceptable; then run `/oauth-billing current` (or `/oauth-billing` for the visible loaded sessions). `/oauth-audit` gives detailed allowlisted evidence. This describes the last observed response, not a promise about later requests.
5. For actual cost confirmation, reconcile the corresponding provider account's usage/billing records. A reported plan claim is useful evidence but does not establish which seat paid, exclusive plan coverage, or no extra usage.

Do not add cloud credentials to the standing preview home for this test. Existing live credentials should remain under the existing credential service; the audit never needs a copy. There is no automatic install into every deployment or change to the global install roster.

## Troubleshooting and failed approaches

| Symptom / approach | Cause and action |
|---|---|
| `oauthBetas` fails | A configured `anthropic-beta` replaces pi-ai defaults. Restore the needed OAuth flags alongside compatible optional flags; the audit does not silently rewrite feature flags. |
| `oauthBearer` or `noApiKey` fails | The selected audited route is not producing OAuth-only auth. Correct the route/credential selection; no silent API-key fallback is attempted by this plugin. |
| `identity` fails | OAuth wire construction changed or a non-OAuth path was used. Inspect the installed dependency; do not edit the persisted system prompt merely to add a second identity line. |
| `jsonBody` fails | Only serialized string `init.body` up to 32 MiB is supported. Unsupported streaming/Request-only bodies are refused without reading them. |
| `endpoint` fails | A custom base URL, gateway, or different protocol is configured. The audit supports only the official HTTPS Messages endpoint; it does not forward credentials to a custom target. |
| `unknown` / unfamiliar headers | Insufficient evidence, not proof of API billing. Check logs and account records. Observe mode continues unchanged; audit mode requires explicit `onUnverified: warn` to continue. |
| `unobserved` with successful output | Cached fetch, custom transport, unsupported metadata, or no retained observation. Observe mode preserves success. Audit mode refuses it; neither can undo earlier network dispatch. |
| Authentication/cancellation becomes an audit failure | Regression: pi-ai emits usage before its terminal error. Tests pin preservation of this order. |
| Nested API-key requests get blocked | Regression: clearing asynchronous context only at iterator creation is insufficient. The plugin clears it on each unselected iterator advancement and cleanup. |
| Capturing Request bodies hangs after abort | Reading `Request.clone().text()` can hang on an unending stream. That approach was removed; unsupported forms now fail closed. |
| A purportedly sanitized header contains a token | Character filtering is insufficient. The final classifier uses per-field enums/numeric validation and redacts other values. |
| A greeting succeeded before this plugin was installed | A saved assistant reply contains no routing headers. There is no honest retrospective billing verdict from that transcript alone. |
| Observer disappears in real Loader despite passing a direct `apply` test | Config validation is followed by resolution in `apply`; observe defaults must omit audit-only keys so resolution stays idempotent. The real Loader command test pins this. |
| Passive observer strips authorization | Constructing Headers can consume a one-shot HeadersInit iterable. Observe only reusable native/plain metadata and skip iterable/accessor/coercible forms without touching them. |
| Unknown local sessions appear together | `local` and `token` are unattributed ownership sentinels, not shared-user identities. The report restricts them to the invoking session. |
| Recent report disappears after restart | Intentional bounded in-memory storage; an old transcript has no HTTP headers to reconstruct it. |

Tests initially exposed a duplicate terminal failure after a native abort and a usage-before-error misclassification. Both were fixed with terminal handling and real adapter fixtures. A review also caught nested asynchronous-context leakage, permissive header-value filtering, and unbounded Request-body inspection; regression tests cover the resulting behavior. The integration harness resolves dependencies relative to the current submodule, not a similarly named sibling checkout.
