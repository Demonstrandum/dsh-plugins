# Billing status plugin — first isolated implementation

**Status: implemented and tested offline; not installed or activated in a live profile.** This is the first increment of the [provider-neutral plan](provider-neutral-billing-status-plan.md), not completion of every provider/transport integration. The [plugin README](../plugins/billing-status/README.md) owns configuration, capabilities, security and limitations.

## Changes

Added the opt-in `tali-billing-status` package, with no fork modification and no mandatory sibling plugin:

- Native Anthropic OAuth response evidence, with the picker-style OAuth shield, positive subscription-window claims, explicit extra usage and unknown/stale states.
- Native OpenRouter chat-completion receipts from HTTP SSE/JSON. Capture preserves the cost's decimal JSON lexeme, distinguishes upstream BYOK cost, and doesn't make reconciliation requests.
- Codex HTTP quota/credit observations, explicitly distinct from an Anthropic subscription claim. WebSocket evidence remains unobserved.
- Token-price estimates from DSH's own model catalog: the custom fork adds optional `pricing` to `LlmResolvedModelInfo`, which `llm-pi-ai` fills from the installed pi-ai catalog (the same data the pi coding agent prices with; OpenCode uses models.dev and Aider LiteLLM's price file for the same purpose). Billing calls `ctx.llm.resolveModelInfo()` instead of importing pi-ai, stores the catalog version on each estimate, and prices older recorded usage at read time. Optional explicit rate cards still override; DSH normalized input is **disjoint**, so inclusive-input cards are rejected instead of subtracting cache twice. Missing prices stay unpriced.
- Append-only plugin-owned request accounting with decimal arithmetic, retry identities, cumulative replacement, duplicate-receipt reconciliation, fixed historical rates, restart recovery and partial/error states.
- Optional `/billing` command and authenticated snapshot route. Headless collection mounts without commands, connection, OAuth commands or the existing audit plugin.
- Compact browser footer, session-safe polling, short details, keyboard/outside-click dismissal, tabular amounts and explicit coverage/freshness.

No package was added to installation lists or overlays. No live profiles, credentials, provider configuration, core checkout sources or installed client bundles were changed.

## Decisions and failures that mattered

| Finding | Implementation decision |
|---|---|
| Dock slot precedes ContextMeter | Keep the natural before-meter position. CSS order1 moved it visually right but left keyboard/screen-reader order before it; fixture and real Tab navigation confirmed the mismatch. No core patch or positive tabindex. |
| Current DSH append cannot mark custom billing events ignorable | Store request accounting separately; do not add arbitrary required session-log events. |
| Independent observers would wrap/capture the same response twice | Extract a dependency-free [canonical passive protocol](../libraries/passive-fetch/README.md), shipping identical generated copies in both packages. Observe mode shares one wrapper/capture; enforcing audit remains a separate explicit policy. Packed-package tests prove no sibling-directory/enabled-plugin dependency. |
| Ownership attribution is not authorization | Review rejected using the legacy tracker: malformed/rejected requests can create misleading owner labels. The optional remote adapter instead verifies an admitted requester against explicit operator `billingSessionOwners` bindings, defaulting to none. No automatic migration; forged labels never grant billing access. |
| Connection remount recreated the first authorization latch | Keep the ever-observed/marked ownership requirement in a root-keyed weak map shared across module instances. The remote provider marks it even before billing mounts; disappearing services cannot reopen the route after connection/plugin remount. Real Cordis tests reproduce and prevent the original fail-open. |
| Requests can start within one clock millisecond | Use local start ordering/identity, not timestamp comparison, to prevent an older late response restoring stale route/account evidence. |
| Custom route names need not disclose actual OAuth | Native observed OAuth evidence suppresses API estimates even for aliases. Native OpenRouter receipts are accepted on aliases when the collector verified the canonical endpoint. |
| Failed pi-ai calls emit synthetic all-zero usage | Withhold zero usage until successful completion; failed requests with no real usage remain unknown, not free. |
| Parser and UI disagreed on OpenRouter charge scope | Use the actual `openrouter-account` scope end to end; different currencies stay distinct and are never converted. |
| A crash may leave a writer lock or a partial line | Do not steal the lock or append after damage. Replay valid history read-only and show partial/unhealthy state; manual recovery requires confirming no active writer. |
| Reconciliation can correct a previous receipt amount | Last-observation order chooses the newest receipt, not the first occurrence of its generation ID. |

## Verification

Final results after shared capture and authorization work: **185 automated unit/contract/regression tests**, **12 real Cordis/DSH/pi-ai integration tests** (four provider fixtures and eight authorization/lifecycle cases), strict TypeScript checking and the new-plugin build passed. The unchanged browser client also passed **12 current-build Chrome fixture checks**. No real provider account was billed or queried.

Commands, run without real provider calls:

```sh
# In the new plugin only — no root or other-plugin build/install:
pnpm install --ignore-scripts
pnpm typecheck
pnpm build
pnpm test

# From the DSH checkout; the network is replaced by fixtures:
node --import tsx/esm --test ../plugins/anthropic-oauth-audit/tests/integration.mjs ../plugins/billing-status/tests/collector-integration.mjs ../plugins/billing-status/tests/integration.mjs ../plugins/billing-status/tests/authorization-integration.mjs

# From this repository: shared-copy consistency and sibling regressions, without builds:
node libraries/passive-fetch/sync.mjs --check
node --test libraries/passive-fetch/shared.test.mjs plugins/anthropic-oauth-audit/tests/*.test.mjs plugins/billing-status/tests/*.test.mjs plugins/dsh-tailscale-remote/tests/*.test.mjs

# From this repository, for a disposable mocked browser fixture:
node plugins/billing-status/tests/fixture-server.mjs
```

- Provider/transport tests cover exact money, bounded streaming, cancellation/error preservation, concurrent attribution, native retries, synthetic-zero handling and all four audit load/unload permutations, one native metadata capture, independent nested scopes, one OpenRouter parser and standalone npm tarball loading.
- Ledger/host tests cover cumulative replacement, retry summation, receipt correction/dedup, currencies and precision, cache rates, OAuth aliases, stale races, secret filtering, corrupt logs, concurrent writers, restart, fork isolation and fail-closed authorization.
- Real Cordis/Loader/pi-ai fixtures confirm Anthropic OAuth and OpenRouter wire observations while preserving ordinary replies; the full host test confirms receipts reach durable accounting. No real login, token refresh service or inference endpoint is contacted.
- Chrome browser checks cover shield/claim display, quota versus plan versus currency, explicit zero versus missing, stale/partial/error states, rejection of wrong-session data,403 clearing, hidden/unmounted cancellation, focus restoration and Escape. The fixture demonstrates natural keyboard order and no overflow in a true320px embedded viewport.
- Safari automation reported a hidden document and did not paint; the client correctly made no background requests, but Safari visual verification is **not claimed**.
- Authorization regression tests cover a real ephemeral proxy/Fetch route, spoofed headers, token-only denial, one-use/expired/disposed grants, explicit bindings versus poisoned legacy attribution, service disappearance before first request, connection/plugin/module remounts and independent Cordis roots. The old tracker's attribution defects were not repurposed into an authorization source.
- The full remote suite exposed two pre-existing synthetic identity fixtures whose replacement display phrase was not a valid login (and disagreed with their expected `user@example.com`). They now use consistent example logins; no production identity policy was loosened.
- Only the new, uninstalled client bundle was built. The mock fixture server is disposable and stopped after verification.

## Next increment / rollout gate

Before trying this in an ownership-aware instance, review and configure the optional adapter's **explicit session-to-login bindings**; unbound sessions and token-only readers intentionally remain unavailable. Automatic financial-owner discovery/migration is unsupported. Remaining provider work includes supported Codex WebSocket hooks, optional OpenRouter lookup reconciliation, maintained pricing cards and richer service-tier/model/media/tool pricing. Trial the actual package in an isolated DSH preview before seeking explicit live-install approval. Do not treat the mock UI or fake-provider integrations as verification of real account billing or live activation.
