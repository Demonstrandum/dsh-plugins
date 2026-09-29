# Anthropic OAuth request and routing audit

## Goal and findings

Compare the existing DSH OAuth route with Rho's Anthropic integration and expose request/response evidence without claiming to know the provider's settled billing.

The inspected local Rho checkout has three separate pieces:

- `extensions/prompt-defingerprint.ts`: rewrites three Pi-specific documentation instruction lines. These are not DSH's prompt instructions; copying the regexes into DSH would not establish anything about its classification.
- `extensions/prompt-disenshittify.ts`: a general prompt house-style transform, not a billing verifier. It runs before the transport adds the Claude identity block. It is not ported.
- `extensions/extra-usage-watch.ts`: observes `anthropic-ratelimit-unified-*` headers. It considers `five_hour` and `seven_day` representative claims plan evidence, warns about other claims, and watches aggregate overage utilization. Unknown claims and non-plan 429s cannot safely establish billed overage. Its warning-clearing behavior can also erase an aggregate-increase warning immediately after raising it; this behavior is not copied.

Rho's investigation notes record historical accepted/rejected requests and header observations, with same-day classifier changes and utilization confounding. They do not reconcile invoices or account ledgers. OAuth acceptance, HTTP 200, CLI-like request formatting, plan-window limiter claims, and confirmed seat billing are different facts. Subscription extra usage and platform API billing are also different funding paths.

The inspected DSH fork's `anthropic-oauth` route is implemented in the in-tree `llm-pi-ai` and authorization plugins, not one of the public out-of-tree plugins. Existing uncommitted OAuth implementation changes are left untouched. The route's pi-ai 0.87.1 dependency already implements:

1. OAuth login/refresh and Bearer access tokens, separately from the API-key provider route.
2. The first system block `You are Claude Code, Anthropic's official CLI for Claude.`
3. OAuth/Claude Code beta flags and `x-app: cli`.
4. Reversible canonical casing for known tool names; custom names remain custom.

One concrete difference is DSH's [request header merger](../deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts), which overwrites pi-ai's CLI User-Agent with DSH's [mandatory attribution](../deepseek-harness/packages/llm/llm/src/attribution.ts). The new plugin prefixes a configured CLI token while preserving DSH attribution. No claim is made that the combined value is an exact official-client replica or that this header caused any observed billing behavior.

A referenced existing session was confirmed to select the dedicated OAuth route and complete a greeting, but its transcript did not record HTTP response headers. That old turn therefore cannot be retrospectively verified with this method. No real credentials were read and no live Anthropic calls were made during this change.

## Implementation

[Plugin README](../plugins/anthropic-oauth-audit/README.md) owns configuration, status meanings, limitations, and tests. The implementation is entirely under [the plugin entry](../plugins/anthropic-oauth-audit/index.js), [scoped transport](../plugins/anthropic-oauth-audit/transport.mjs), and [evidence classifier](../plugins/anthropic-oauth-audit/evidence.mjs). No fork changes or live configuration edits are needed to develop it.

The current DSH adapter does not expose pi-ai's transport callbacks to sibling plugins, so the plugin uses the public `llm/stream` event plus a reversible, asynchronous-context-scoped fetch wrapper. It checks actual serialized requests and actual response headers rather than making a tiny probe with an unrelated prompt. A future adapter transport-observation seam could replace the global wrapper; duplicating the entire OAuth provider is not necessary.

Default behavior is conservative: preflight violations never dispatch; accepted overage/unknown responses stop with a visible `ANTHROPIC_OAUTH_AUDIT` error. `/oauth-audit` displays the latest retained report for the session, and internal logs contain allowlisted evidence. `onUnverified: warn` is an explicit log-only choice. Native HTTP/auth/network/cancellation errors stay native. The first request has already been dispatched before any response-based stop: this cannot guarantee zero charges. Provider-side spending controls remain necessary.

## Reproduce offline

From the plugins checkout:

```sh
node --check plugins/anthropic-oauth-audit/index.js
node --check plugins/anthropic-oauth-audit/transport.mjs
node --test plugins/anthropic-oauth-audit/tests/*.test.mjs
```

From its `deepseek-harness/` submodule:

```sh
node --import tsx/esm --test ../plugins/anthropic-oauth-audit/tests/integration.mjs
```

The second command uses a temporary Loader composition, current DSH adapter source, installed pi-ai, a fake credential store, and entirely stubbed HTTP. No settings, credentials, sessions, browser bundle, or running server are changed. It also verifies that ordinary API-key requests retain their original authentication and DSH attribution.

## Roll out deliberately

1. Obtain confirmation before changing the live instance. This implementation has **not** been installed or activated there.
2. From the DSH checkout, install only this bundle into the intended profile:

   ```sh
   pnpm dsh plugin --profile web add ../plugins/anthropic-oauth-audit
   ```

3. Restart that instance when no work will be interrupted. Host module edits are not source-hot-reloaded.
4. Keep the session on `anthropic-oauth`, not `anthropic`. Send a normal turn only when its possible usage cost is acceptable; then run `/oauth-audit`. This is an observation of that exact request, not a promise about later requests.
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
| `unknown` / unfamiliar headers | There is insufficient evidence, not proof of API billing. Check logs and account records. Choose warn-only mode explicitly if continuing despite uncertainty is acceptable. |
| `unobserved` with successful output | A cached fetch/custom transport may bypass the wrapper. The default policy refuses unverified success; it cannot undo any earlier network dispatch. |
| Authentication/cancellation becomes an audit failure | Regression: pi-ai emits usage before its terminal error. Tests pin preservation of this order. |
| Nested API-key requests get blocked | Regression: clearing asynchronous context only at iterator creation is insufficient. The plugin clears it on each unselected iterator advancement and cleanup. |
| Capturing Request bodies hangs after abort | Reading `Request.clone().text()` can hang on an unending stream. That approach was removed; unsupported forms now fail closed. |
| A purportedly sanitized header contains a token | Character filtering is insufficient. The final classifier uses per-field enums/numeric validation and redacts other values. |
| A greeting succeeded before this plugin was installed | A saved assistant reply contains no routing headers. There is no honest retrospective billing verdict from that transcript alone. |

Tests initially exposed a duplicate terminal failure after a native abort and a usage-before-error misclassification. Both were fixed with terminal handling and real adapter fixtures. A review also caught nested asynchronous-context leakage, permissive header-value filtering, and unbounded Request-body inspection; regression tests cover the resulting behavior. The integration harness resolves dependencies relative to the current submodule, not a similarly named sibling checkout.
