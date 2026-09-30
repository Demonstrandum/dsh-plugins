# Anthropic OAuth audit

Host-only DSH plugin for the dedicated `anthropic-oauth` provider. Explicit `mode: observe` passively reports response-header evidence through `/oauth-billing`. The backward-compatible default, `mode: audit`, checks outbound requests, restores a CLI User-Agent token while retaining DSH attribution, and can stop unverified output. Neither mode certifies seat billing, subscription entitlement, provider permission, or zero charges.

## Passive observation

Configure `mode: observe` for billing visibility without enforcement. This mode preserves the original fetch arguments, headers, redirect policy, request/response body ownership, response object, model output, retries, and native errors. It does not repair the User-Agent, inspect prompts, change the identity block, or enable a new authentication path. Reporting/logging failures cannot fail an inference.

Only scoped `anthropic-oauth` calls to the official HTTPS Messages endpoint, using POST with an OAuth Bearer token and no API-key header, can produce evidence. Authentication headers are examined transiently, never stored or logged. Native Headers and plain string-valued header records are supported; iterable/accessor/coercible metadata passes through without observation rather than risking consumption or mutation. Redirected or unsupported response metadata also remains unobserved. Refresh requests and unrelated endpoints pass unchanged. No probes, polling, token refreshes, credential reads, or account API calls are added.

Observe mode now shares the [passive fetch protocol](../../libraries/passive-fetch/README.md) with the optional billing-status plugin. Each package ships an identical generated copy and works alone; when both are enabled, one wrapper captures native response metadata once and dispatches to independent async scopes. Billing does not enable this plugin, change the default mode, or weaken explicit enforcement. Edit only the canonical library and regenerate/check the copies as documented there.
## Audit mode

- Uses the existing `/oauth` credential flow and pi-ai transport; it does not read credential files, implement login, refresh tokens itself, or fall back to API keys.
- On the selected route, refuses requests before dispatch unless they use the official HTTPS Messages endpoint, OAuth Bearer authentication, no `x-api-key`, the OAuth beta flags, `x-app: cli`, the exact pi-ai identity block, and canonical casing for pi-ai's known tool names. Unknown/custom tool names are allowed. These are compatibility checks, not an exhaustive model of private server checks.
- Restores the `claude-cli/2.1.280` User-Agent prefix that DSH's mandatory attribution otherwise replaces; keeps the original attribution after it. This combined value is not claimed to be identical to the official client or proven necessary for plan routing. The default version matches the inspected pi-ai 0.87.1 implementation; maintain it through `cliUserAgent` when the dependency changes.
- Does **not** rewrite the prompt, rename tools, or copy Rho's Pi-specific documentation rewrites. pi-ai already supplies the identity block and reversible known-tool casing. DSH does not contain the Pi documentation instructions that those rewrites target.
- Inspects every observed Messages response, including non-2xx responses, without consuming or cloning its SSE body. No extra inference/probe requests are made.
- Logs structured, allowlisted evidence under `anthropic-oauth-audit`. Request reports contain booleans and failed-check names, never authorization, cookies, prompts, bodies, or tool descriptions. Response values use enum/numeric validation; unfamiliar values become `[unrecognized]`.
- Adds `/oauth-audit`, showing only this session's most recent retained report since plugin startup. Reports are bounded in memory; server logs retain the historical observations. No browser bundle or new toast surface is needed.

## Outcomes and visible errors

| Observation | Report | Audit behavior (observe mode never stops output) |
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

## Billing report

Both modes register these read-only commands:

- `/oauth-billing`: loaded sessions with an Anthropic OAuth request or retained observation, including unobserved sessions. If the Agent registry is absent, the heading explicitly says retained sessions instead.
- `/oauth-billing current`: only the invoking session.
- `/oauth-billing recent`: retained observations, including unloaded sessions.
- `/oauth-audit`: the existing detailed current-session report, including allowlisted header values and audit checks where available.

Rows show the full session id, a fixed outcome label, last-observed provider/model, HTTP status, observation time, and available 5h/7d/overage utilization percentages. Zero utilization is preserved. Observations older than `staleAfterMs` (default five minutes) are marked stale; this is display age, not an expiry of account entitlement. Missing evidence stays unobserved; unknown evidence never becomes a claim of API-key billing. The report contains no billed-dollar estimate. A subscription claim does not exclude partial extra usage.

Scope is one Host process, not all DSH applications or every signed-in provider/account. Only Anthropic OAuth is supported. A retained row is the last response observed, which may belong to an auxiliary title request or an older overlapping turn that completed later. It is not necessarily the current selected model or latest initiated turn. Records are bounded by `maxSessions` (default 256), cleared on unload/restart, and not reconstructed from old transcripts. Utilization is account-wide and must not be summed across sessions.

When the optional `sessionOwners` attribution service is present, cross-session rows require matching known owner and actor; unknown, `local`, or `token` attribution restricts the view to the invoking session. No identities or session titles are printed. Attribution is not a replacement for Host authorization. Without that service, the view assumes the Host's existing trusted single-principal access, like its Agent registry.

## Install and configure

The plugin is part of the live set installed by `tools/install-plugins.sh` (since 2026-10-01). Its bundle row carries `config: { mode: observe }`, so an installed bundle observes from its first load and never briefly activates the enforcing default; the code default stays `mode: audit` for explicit rows without a mode. From the DSH source checkout, a single profile:

```sh
pnpm dsh plugin --profile web add ../plugins/anthropic-oauth-audit
```

No live install, restart, configuration change, or paid validation is part of the development tests. Do not add cloud credentials to a preview home.

Passive profile override (the whole config is replaced, not deep-merged):

```yaml
- id: tali-anthropic-oauth-audit
  config:
    mode: observe
    maxSessions: 256
    staleAfterMs: 300000
```

Observe mode supports only `providers: [anthropic-oauth]` and rejects `cliUserAgent` and `onUnverified`, because those options would misleadingly imply request repair or enforcement. Both modes validate positive integer retention and stale-age settings.

To deliberately select the original enforcing audit behavior instead:

```yaml
- id: tali-anthropic-oauth-audit
  config:
    mode: audit
    providers: [anthropic-oauth]
    cliUserAgent: claude-cli/2.1.280
    onUnverified: error
    maxSessions: 256
```

In audit mode, do not add the ordinary `anthropic` route unless it is intentionally OAuth-only: API-key requests on any selected route are blocked. Neither mode changes the selected model or provider. After a normal OAuth turn, run `/oauth-billing`. Audit mode with `onUnverified: warn` still rewrites headers and blocks preflight violations; it is **not** passive observation.

## Implementation and limits

`llm/stream` exposes request/chunk interception, but the current DSH pi-ai adapter does not expose pi-ai's per-call `fetch`, `onPayload`, or `onResponse` hooks to sibling plugins. This plugin therefore wraps `globalThis.fetch` reversibly and scopes it with `AsyncLocalStorage` around iterator construction, advancement, and cleanup. Unselected nested streams explicitly clear that scope. Concurrent API-key sessions and fetches outside an audited LLM call are unchanged. Only one mounted instance is allowed per process.

Within an audit-mode call only the official Messages endpoint and pi-ai's exact OAuth refresh endpoint are supported. Redirect following is disabled on both, to avoid forwarding credentials to a different destination. Custom gateways/base URLs are deliberately unsupported. The SDK's serialized string `init.body` is inspected, up to 32 MiB; other body forms, including a body stored solely in `Request`, fail closed without draining a stream. The current installed SDK uses the supported form. Request body and signal remain unchanged.

A different SDK, cached fetch reference, custom HTTP client, or native transport can bypass the fetch wrapper; audit mode refuses otherwise-successful unobserved output, whereas observe mode preserves it and reports unobserved. This cannot retroactively prevent that network request. The wrapper is a compatibility/diagnostic mechanism, not a universal security or billing boundary. When disposed, it stops reporting and restores the previous fetch if still on top; it never overwrites a later wrapper. A retained wrapper becomes an inactive passthrough.

System/tool content and cache boundaries are unchanged. Only audit mode adjusts HTTP headers; observe mode does not. Normal error/abort streams can emit token usage before their terminal error; the auditor preserves those rather than replacing them with a spurious unobserved failure. A plan-evidence report describes an HTTP response, not eventual completion of its stream.

## Tests

From this plugin directory:

```sh
node --check index.js
node --check transport.mjs
node --check billing.mjs
node --test tests/*.test.mjs
```

From `deepseek-harness/` (uses the current source adapter and installed pi-ai):

```sh
node --import tsx/esm --test ../plugins/anthropic-oauth-audit/tests/integration.mjs
```

The integration test loads a temporary `cordis.yml` through Cordis Loader/Include, the real LLM service and pi-ai adapter, and this plugin. Only the credential store and HTTP responses are fixtures. It checks parallel OAuth/API-key requests, identity and Unicode preservation, known-tool round trips, beta overrides, token refresh, overage/unknown/429 handling, cancellation, missing credentials, and disposal. It never uses real credentials or contacts Anthropic. A second real Loader composition includes the command registry and verifies observe-mode activation, unchanged OAuth wire format/DSH User-Agent, plan/overage/unknown reports without additional requests, native 429 errors, and disposal. Unit tests additionally check nested-call isolation, redaction, bounded report retention, stale observations, session scope and actual ownership filtering, one-shot header iterables, accessor metadata, warnings, unsupported bodies, and coexistence with another fetch wrapper.

See [the recipe](../../recipes/anthropic-oauth-audit.md) for the comparison with Rho and the rollout procedure.
