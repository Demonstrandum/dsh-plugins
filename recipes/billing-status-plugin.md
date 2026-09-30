# Billing status plugin — first isolated implementation

**Status: implemented and tested offline; not installed or activated in a live profile.** This is the first increment of the [provider-neutral plan](provider-neutral-billing-status-plan.md), not completion of every provider/transport integration. The [plugin README](../plugins/billing-status/README.md) owns configuration, capabilities, security and limitations.

## Changes

Added the opt-in `tali-billing-status` package, with no fork modification and no mandatory sibling plugin:

- Native Anthropic OAuth response evidence, with the picker-style OAuth shield, positive subscription-window claims, explicit extra usage and unknown/stale states.
- Native OpenRouter chat-completion receipts from HTTP SSE/JSON. Capture preserves the cost's decimal JSON lexeme, distinguishes upstream BYOK cost, and doesn't make reconciliation requests.
- Codex HTTP quota/credit observations, explicitly distinct from an Anthropic subscription claim. WebSocket evidence remains unobserved.
- Versioned, explicitly configured API token rate cards; DSH normalized input is **disjoint**, so inclusive-input cards are rejected instead of subtracting cache twice. Missing prices stay unpriced.
- Append-only plugin-owned request accounting with decimal arithmetic, retry identities, cumulative replacement, duplicate-receipt reconciliation, fixed historical rates, restart recovery and partial/error states.
- Optional `/billing` command and authenticated snapshot route. Headless collection mounts without commands, connection, OAuth commands or the existing audit plugin.
- Compact browser footer, session-safe polling, short details, keyboard/outside-click dismissal, tabular amounts and explicit coverage/freshness.

No package was added to installation lists or overlays. No live profiles, credentials, provider configuration, core checkout sources or installed client bundles were changed.

## Decisions and failures that mattered

| Finding | Implementation decision |
|---|---|
| Dock slot precedes ContextMeter | Keep the natural before-meter position. CSS order1 moved it visually right but left keyboard/screen-reader order before it; fixture and real Tab navigation confirmed the mismatch. No core patch or positive tabindex. |
| Current DSH append cannot mark custom billing events ignorable | Store request accounting separately; do not add arbitrary required session-log events. |
| Existing Anthropic audit owns its own fetch wrapper | New collectors share a passive broker; the legacy audit safely composes in both load/unload orders but is not yet migrated to the same library. Never enable enforcement from billing. |
| Ownership attribution is not authorization | A composition exposing `sessionOwners` must also provide a verified `billingAccess.canRead(request, sessionId)` service, otherwise the new route returns403. Raw identity headers are not trusted. A remote-owner authorization adapter is still a rollout prerequisite. |
| Requests can start within one clock millisecond | Use local start ordering/identity, not timestamp comparison, to prevent an older late response restoring stale route/account evidence. |
| Custom route names need not disclose actual OAuth | Native observed OAuth evidence suppresses API estimates even for aliases. Native OpenRouter receipts are accepted on aliases when the collector verified the canonical endpoint. |
| Failed pi-ai calls emit synthetic all-zero usage | Withhold zero usage until successful completion; failed requests with no real usage remain unknown, not free. |
| Parser and UI disagreed on OpenRouter charge scope | Use the actual `openrouter-account` scope end to end; different currencies stay distinct and are never converted. |
| A crash may leave a writer lock or a partial line | Do not steal the lock or append after damage. Replay valid history read-only and show partial/unhealthy state; manual recovery requires confirming no active writer. |
| Reconciliation can correct a previous receipt amount | Last-observation order chooses the newest receipt, not the first occurrence of its generation ID. |

## Verification

Final first-increment results: **54 automated unit/contract tests**, **2 real DSH/pi-ai offline integration tests**, strict TypeScript checking and the new-plugin build passed. All **12 current-build Chrome fixture checks** passed as well.

Commands, run without real provider calls:

```sh
# In the new plugin only — no root or other-plugin build/install:
pnpm install --ignore-scripts
pnpm typecheck
pnpm build
pnpm test

# From the DSH checkout; the network is replaced by fixtures:
node --import tsx/esm --test ../plugins/billing-status/tests/collector-integration.mjs ../plugins/billing-status/tests/integration.mjs

# From this repository, for a disposable mocked browser fixture:
node plugins/billing-status/tests/fixture-server.mjs
```

- Provider/transport tests cover exact money, bounded streaming, cancellation/error preservation, concurrent attribution, native retries, synthetic-zero handling and all four legacy-audit load/unload permutations.
- Ledger/host tests cover cumulative replacement, retry summation, receipt correction/dedup, currencies and precision, cache rates, OAuth aliases, stale races, secret filtering, corrupt logs, concurrent writers, restart, fork isolation and fail-closed authorization.
- Real Cordis/Loader/pi-ai fixtures confirm Anthropic OAuth and OpenRouter wire observations while preserving ordinary replies; the full host test confirms receipts reach durable accounting. No real login, token refresh service or inference endpoint is contacted.
- Chrome browser checks cover shield/claim display, quota versus plan versus currency, explicit zero versus missing, stale/partial/error states, rejection of wrong-session data,403 clearing, hidden/unmounted cancellation, focus restoration and Escape. The fixture demonstrates natural keyboard order and no overflow in a true320px embedded viewport.
- Safari automation reported a hidden document and did not paint; the client correctly made no background requests, but Safari visual verification is **not claimed**.
- Only the new, uninstalled client bundle was built. The mock fixture server is disposable and stopped after verification.

## Next increment / rollout gate

Before trying this in an ownership-aware live instance, implement and verify its authorization adapter. Remaining provider work includes supported Codex WebSocket hooks, optional OpenRouter lookup reconciliation, maintained pricing cards and richer service-tier/model/media/tool pricing. Then trial the actual package in an isolated DSH preview and seek explicit live-install approval. Do not treat the mock UI or fake-provider integrations as verification of real account billing or live activation.
