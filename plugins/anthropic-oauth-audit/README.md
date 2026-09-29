# Anthropic OAuth audit

Host-only DSH plugin for the dedicated `anthropic-oauth` provider. It checks the actual outbound request, restores a CLI User-Agent token while retaining DSH attribution, and reports Anthropic's response-header routing evidence. It does **not** certify seat billing, subscription entitlement, provider permission, or zero charges.

## What it does

- Uses the existing `/oauth` credential flow and pi-ai transport; it does not read credential files, implement login, refresh tokens itself, or fall back to API keys.
- On the selected route, refuses requests before dispatch unless they use the official HTTPS Messages endpoint, OAuth Bearer authentication, no `x-api-key`, the OAuth beta flags, `x-app: cli`, the exact pi-ai identity block, and canonical casing for pi-ai's known tool names. Unknown/custom tool names are allowed. These are compatibility checks, not an exhaustive model of private server checks.
- Restores the `claude-cli/2.1.280` User-Agent prefix that DSH's mandatory attribution otherwise replaces; keeps the original attribution after it. This combined value is not claimed to be identical to the official client or proven necessary for plan routing. The default version matches the inspected pi-ai 0.87.1 implementation; maintain it through `cliUserAgent` when the dependency changes.
- Does **not** rewrite the prompt, rename tools, or copy Rho's Pi-specific documentation rewrites. pi-ai already supplies the identity block and reversible known-tool casing. DSH does not contain the Pi documentation instructions that those rewrites target.
- Inspects every observed Messages response, including non-2xx responses, without consuming or cloning its SSE body. No extra inference/probe requests are made.
- Logs structured, allowlisted evidence under `anthropic-oauth-audit`. Request reports contain booleans and failed-check names, never authorization, cookies, prompts, bodies, or tool descriptions. Response values use enum/numeric validation; unfamiliar values become `[unrecognized]`.
- Adds `/oauth-audit`, showing only this session's most recent retained report since plugin startup. Reports are bounded in memory; server logs retain the historical observations. No browser bundle or new toast surface is needed.

## Outcomes and visible errors

| Observation | Report | Default behavior |
|---|---|---|
| 2xx, recognized `five_hour`/`seven_day` representative claim, and unified status `allowed`/`allowed_warning` | `plan-evidence` | Continue; log the evidence, not a billing guarantee |
| 2xx with explicit `overage` representative claim | `extra-usage` | Stop the call with a visible audit error |
| 2xx with missing, unfamiliar, or inconclusive headers | `unknown` | Stop the call with a visible audit error; **not** a claim that API billing occurred |
| Non-2xx | `rejected` | Log evidence and preserve the provider error/retry behavior |
| Failed outbound check | `blocked` | Do not dispatch; return a visible error even if the SDK wraps it as a connection failure |
| No observed response | `unobserved` | Preserve native auth/network/cancellation errors; refuse otherwise-successful unobserved output |

Default policy errors use `ANTHROPIC_OAUTH_AUDIT`, outside DSH's default retryable-code set. Do not add it to a retry policy: a repeated request can incur additional usage. `onUnverified: warn` keeps accepted output and logs unknown/overage warnings instead; pre-dispatch violations still refuse.

A response arrives **after dispatch**. Stopping the stream can prevent the agent from proceeding to its next tool/model step, but cannot prevent or refund charges on that request. This is not a spend cap. Use the provider's account controls and billing records to control and reconcile spend. In particular, paid subscription extra usage is distinct from platform API-key billing.

If account-wide `overage-utilization` rises between retained observations in a session, the log and command warn independently of a plan claim. Other clients or sessions may be responsible; the plugin never attributes this aggregate change to one request. A plan-window claim does not exclude mixed funding or paid extra usage.

## Install and configure

From the DSH source checkout, after explicitly choosing the destination profile:

```sh
pnpm dsh plugin --profile web add ../plugins/anthropic-oauth-audit
```

Restart that instance when safe. Installing/editing a live profile can apply immediately; obtain approval for that separately. No live install, restart, configuration change, or paid validation is part of the development tests.

Optional profile patch (the whole config is replaced, not deep-merged):

```yaml
- id: tali-anthropic-oauth-audit
  config:
    providers: [anthropic-oauth]
    cliUserAgent: claude-cli/2.1.280
    onUnverified: error
    maxSessions: 256
```

Do not add the ordinary `anthropic` route unless it is intentionally OAuth-only: API-key requests on any selected route are blocked. The plugin does not change the selected model or provider. After a normal OAuth turn, run `/oauth-audit`. For log-only operation choose `onUnverified: warn` explicitly.

## Implementation and limits

`llm/stream` exposes request/chunk interception, but the current DSH pi-ai adapter does not expose pi-ai's per-call `fetch`, `onPayload`, or `onResponse` hooks to sibling plugins. This plugin therefore wraps `globalThis.fetch` reversibly and scopes it with `AsyncLocalStorage` around iterator construction, advancement, and cleanup. Unselected nested streams explicitly clear that scope. Concurrent API-key sessions and fetches outside an audited LLM call are unchanged. Only one mounted instance is allowed per process.

Within an audited call only the official Messages endpoint and pi-ai's exact OAuth refresh endpoint are supported. Redirect following is disabled on both, to avoid forwarding credentials to a different destination. Custom gateways/base URLs are deliberately unsupported. The SDK's serialized string `init.body` is inspected, up to 32 MiB; other body forms, including a body stored solely in `Request`, fail closed without draining a stream. The current installed SDK uses the supported form. Request body and signal remain unchanged.

A different SDK, cached fetch reference, custom HTTP client, or native transport can bypass the fetch wrapper; a successful stream with no observed response then fails as unobserved. This cannot retroactively prevent that network request. The wrapper is a compatibility/diagnostic mechanism, not a universal security or billing boundary. When disposed, it stops reporting and restores the previous fetch if still on top; it never overwrites a later wrapper. A retained wrapper becomes an inactive passthrough.

System/tool content and cache boundaries are unchanged. Only HTTP headers are adjusted. Normal error/abort streams can emit token usage before their terminal error; the auditor preserves those rather than replacing them with a spurious unobserved failure. A plan-evidence report describes an HTTP response, not eventual completion of its stream.

## Tests

From this plugin directory:

```sh
node --check index.js
node --check transport.mjs
node --test tests/*.test.mjs
```

From `deepseek-harness/` (uses the current source adapter and installed pi-ai):

```sh
node --import tsx/esm --test ../plugins/anthropic-oauth-audit/tests/integration.mjs
```

The integration test loads a temporary `cordis.yml` through Cordis Loader/Include, the real LLM service and pi-ai adapter, and this plugin. Only the credential store and HTTP responses are fixtures. It checks parallel OAuth/API-key requests, identity and Unicode preservation, known-tool round trips, beta overrides, token refresh, overage/unknown/429 handling, cancellation, missing credentials, and disposal. It never uses real credentials or contacts Anthropic. Unit tests additionally check nested-call isolation, redaction, bounded report retention, warnings, unsupported bodies, and coexistence with another fetch wrapper.

See [the recipe](../../recipes/anthropic-oauth-audit.md) for the comparison with Rho and the rollout procedure.
