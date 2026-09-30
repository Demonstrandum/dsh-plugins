# Provider-neutral billing status — research and proposed plan

**Status: proposal, not implemented or installed.** Research completed 2026-09-30 against the current checkout, installed pi-ai 0.87.1, public provider documentation, and Tau source. No inference test, live configuration change, or UI deployment was performed. Provider contracts and tariffs must be rechecked at implementation time.

## Decision summary

Build an out-of-tree `billing-status` plugin with a host accounting service and a browser dock contribution. Treat the existing Anthropic observer as one optional evidence adapter, not the identity of the whole feature.

Do not collapse these independent facts:

1. Authentication: OAuth, API key, local, or unknown.
2. Routing evidence: subscription claim, extra usage, rejected, unknown, unobserved.
3. Account usage: named quota windows, reset times, credits, freshness.
4. Session money: provider-reported charges, local estimates, and unpriced requests.

A quota percentage cannot be converted into session dollars. OAuth is not a guarantee of zero additional spend. Missing data is not zero.

## What can be obtained

| Route | Available evidence | Appropriate display |
|---|---|---|
| OpenAI ChatGPT/Codex OAuth | Token usage plus implementation-level quota/credit headers or events, where exposed | Subscription/quota/credits; no invented dollar total |
| Anthropic subscription OAuth | Existing observer's allowlisted plan/overage signals and account usage windows | `Plan claim`, named windows, `Extra usage` when explicitly observed; dollars unknown |
| OpenAI API key | Token usage and pricing dimensions; no standard per-response monetary field | `Est. $1.23` using a versioned applicable rate card |
| Anthropic API key | Token/cache/TTL usage and pricing dimensions; no standard per-response monetary field | `Est. $1.23` with cache and tier assumptions explicit |
| OpenRouter | Final response usage includes account charge; generation lookup can reconcile by ID | `$1.23 reported`, explicitly scoped to the OpenRouter account |
| OpenRouter BYOK | OpenRouter charge and separate upstream information; actual route can fall back | Separate OpenRouter and upstream/BYOK components; not a blind sum |
| Unknown/custom/local routes | Whatever their adapter can establish | `Unknown`, `Unpriced`, or an explicitly configured tariff; never assume free |

### OpenAI OAuth is not API pricing

[Codex pricing](https://learn.chatgpt.com/docs/pricing.md) explicitly says API token prices are separate from subscription usage and must not be used to estimate included tasks. Plans can combine included usage, purchased credits, and contractual billing. [Authentication](https://learn.chatgpt.com/docs/auth.md) distinguishes ChatGPT sign-in from API-key billing.

[OpenAI's Codex rate-limit implementation](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs) parses primary/secondary window percentages/durations/resets, credit information, and named limit families/events. This is implementation evidence, not a universal public billing contract. Use the reported window duration rather than assuming every account has a five-hour and seven-day pair. Balance changes are account-wide, not attributable to one session.

The installed pi-ai Codex adapter supports WebSocket as well as SSE. A fetch-header observer alone does not cover WebSocket events. Do not silently force a different transport just to populate the footer. Unsupported transport evidence must remain explicitly unavailable until a non-invasive integration is verified.

### OpenRouter is the strongest per-request monetary source

[Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting.md) says usage is always included in the final SSE message or full response. The old `usage.include` and `stream_options.include_usage` flags are deprecated and have no effect. `usage.cost` is the charge to the OpenRouter account, while `cost_details.upstream_inference_cost` describes upstream cost.

The [generation lookup](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation.md) exposes `total_cost` in USD, generation identity, `is_byok`, and additional metadata. It can reconcile a missing final usage sample without another inference. Normalize currency/credit units according to the source contract; do not apply arbitrary credit-to-dollar conversions.

For [BYOK](https://openrouter.ai/docs/guides/overview/auth/byok.md), provider inference billing and OpenRouter fees have different scopes. Do not add upstream cost to an ordinary OpenRouter total: that can count the same inference twice. Separate externally billed components, discounts, and unresolved upstream amounts. A configured BYOK account does not prove every request used BYOK.

### API-key estimates need more than total tokens

[OpenAI response usage](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_usage.py) and [Anthropic usage](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/usage.py) report token categories, not dollar receipts.

- OpenAI's input total includes cache categories. Partition uncached/read/write categories; do not add the categories to input again. Current [caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching.md) documents writes separately; older SDK comments may be stale.
- Anthropic input is disjoint from cache reads and writes. Its cache-creation aggregate includes TTL subdivisions; do not add both aggregate and subdivisions. See [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md).
- Reasoning is a subset of output billing totals, not an extra output charge to add twice.
- Rates depend on exact model/version and potentially service tier, context size, region, modality, cache TTL, batch, and negotiated terms. Capture rate provenance and assumptions per request, not the current model's rate applied to historical totals.
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing.md) and [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing.md) include provider-hosted tool/service charges. Ordinary local/MCP tool calls are not automatically these billable server tools.
- Missing usage after cancellation or interruption does not mean free. A failed response may have consumed billable tokens.

Organization cost APIs are a later reconciliation feature, not the live footer's primary source: [OpenAI Costs](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs) and [Anthropic Usage & Cost](https://platform.claude.com/docs/en/manage-claude/usage-cost-api.md) have administrative access, aggregate scopes, and reporting delays. They are not subscriber OAuth request receipts. Avoid requesting administrative credentials for the first version.

## Tau: borrow the presentation, not billing certainty

[Pi Tau](https://pi.dev/packages/pi-tau) is a real project, distinct from the previously researched Rho extension. Source inspected at Tau commit `9bde734e74a31bdbd7f8d2c2c0232ea9cd9f96f0`:

- [Custom footer](https://github.com/Mearman/tau/blob/9bde734e74a31bdbd7f8d2c2c0232ea9cd9f96f0/src/features/custom-footer.ts) sums branch assistant token counts and `usage.cost.total`. It is not an invoice API.
- [Quota bars](https://github.com/Mearman/tau/blob/9bde734e74a31bdbd7f8d2c2c0232ea9cd9f96f0/src/features/quota-bars.ts) read a timestamped Claude HUD snapshot. [SDK integration](https://github.com/Mearman/tau/blob/9bde734e74a31bdbd7f8d2c2c0232ea9cd9f96f0/src/features/agent-sdk/provider.ts) also supplies rate-limit/overage events, but calculates token cost from model rates.
- Do not copy global/account-ambiguous quota state or unchecked stale fallback state. Do not infer historical payment source from the currently selected model's OAuth status.

Claude Code itself distinguishes its [estimated cost status-line field](https://code.claude.com/docs/en/statusline.md) from [subscription usage](https://code.claude.com/docs/en/costs.md). Native status-line JSON documentation does not turn undocumented Anthropic HTTP headers into a guaranteed billing contract. Provider authentication policy remains separate; telemetry must not spoof identity, rewrite authentication, or claim to guarantee subscription treatment.

## Proposed footer

Keep the existing context percentage unchanged: it measures context occupancy, not account quota. Add one compact clickable billing group visually to its right, only when the billing plugin is running.

Examples (illustrative values):

```text
…  Cache hit 96%    ◔ 69%    Plan · 5h 3% · 7d 1%
…  Cache hit 96%    ◔ 69%    $1.23 reported
…  Cache hit 96%    ◔ 69%    Est. $1.23
…  Cache hit 96%    ◔ 69%    $1.23 reported · Est. $0.04 · Mixed
…  Cache hit 96%    ◔ 69%    Billing unknown
```

`Plan` is shorthand for observed plan-claim evidence, not a billing certification. Click details should label it `Plan claim`. API estimates and subscription usage must not be presented as a common bill. For mixed sessions, preserve the monetary buckets and unpriced/subscription count. Explicit overage becomes `Extra usage`; absent amounts remain absent.

Click opens short labelled rows, not explanatory blurbs:

- Scope: this session; optional descendant rollup separately.
- Reported / Estimated / Unpriced requests / Coverage start.
- Per-provider/model breakdown, currency, charge scope, pricing source.
- Current account windows/reset times/credits and observed time; stale marker.
- Last-request billing evidence separate from cumulative session totals.

The current CSS uses a **12px group gap plus 8px horizontal padding on each pill**, giving roughly 28px between visible group contents. Reuse those metrics, typography, subdued color, icon size, tabular numbers, hover state, and stat-dialog behavior instead of adding another 25px margin.

### Placement without a fork

The [dock outlet](../deepseek-harness/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx#L484-L488) renders `conversation.composer.dock` immediately before the built-in context meter. List registration order alone cannot place a contribution after that meter.

The [slot wrapper](../deepseek-harness/packages/client/ui-renderer/src/client/scoped-slots.tsx#L1081-L1089) deliberately uses `display: contents`. A plugin-owned root with flex `order: 1` is therefore a promising **out-of-tree visual placement** after the default-order meter. Validate the actual DOM and browser layout in an isolated fixture before committing to it. No hashed host selectors, node reparenting, or core patch is needed for that candidate.

CSS order does not change DOM/tab order. Test the independent buttons' keyboard navigation and screen-reader sequence explicitly. Do not use positive tabindex to fake ordering. If visual/focus sequencing proves unsuitable, use the existing slot before the meter temporarily and propose a generic trailing outlet upstream rather than patching the fork or replacing the whole composer.

Respect the existing mobile/phone behavior, including configurations that hide the entire dock. In desktop/narrow layouts, shorten the billing label or move breakdowns into the popup; never force horizontal overflow.

## Accounting architecture

### 1. Shared host service and source adapters

Proposed package: `plugins/billing-status/` (not yet created). Host service owns sanitized observations, request attribution, persistence, aggregation, and an authenticated session-scoped read channel. Browser half renders its snapshot and has no provider credentials.

Make the existing [Anthropic observer](../plugins/anthropic-oauth-audit/index.js) optionally publish structured observations through a small service/event contract; retain its current commands and explicit passive mode. Do not parse its human-readable command output or install a second competing fetch wrapper. Unloading the UI/service must not change inference or switch the observer into enforcing audit mode.

Use LLM middleware rather than only agent-loop hooks so auxiliary requests can be accounted for. The title generator already passes a session identity and `purpose: 'session-title'`; verify compaction, summaries, retries, and other producers individually. Unattributed calls must not be assigned to an arbitrary active session.

Provider adapters should preferentially consume native structured telemetry or sanctioned middleware. If metadata observation is needed, scope it to the exact provider request, retain only allowlisted facts, and leave auth, request bodies, redirects, errors, transport selection, cancellation, and response consumption unchanged. Do not clone/buffer an unbounded SSE stream just for accounting.

### 2. Per-request ledger, not footer arithmetic

Minimum conceptual records:

- Local request/attempt identity and optional upstream request/generation ID.
- Session ID, origin session, optional turn/step, auxiliary purpose, provider route, requested/served model, opaque account/profile identity, auth kind, start/finish time.
- Disjoint usage buckets plus available pricing dimensions and completeness.
- Money entries: decimal amount, currency, source (`provider-reported` or `estimated`), charge scope, pricing version/assumptions, final/provisional state.
- Independent quota/routing snapshots: provider/account scope, named window/unit/reset, claim, observation time, freshness, source.

Use decimal monetary arithmetic or an adequately precise fixed-point representation. Round for display, not per request. Unknown rates are not zero; a genuinely zero provider-reported charge is valid.

Receipt enrichment is an upsert by request/attempt identity: terminal usage, provider lookup, and later reconciliation refine one record rather than adding charges repeatedly. Distinct billable retries remain distinct attempts. Failed/cancelled calls with missing settlement remain coverage gaps, not free calls.

Default scope should be **cost incurred by this session**, including attributable auxiliary calls and discarded attempts. Rewind/compaction cannot refund it. Fork/copy imports inherited records as inherited history, not newly incurred spend. Keep descendants separate by default, with a deduplicated optional rollup. Keep provider-account quota snapshots outside session spend; other clients can change them.

Persist the ledger across host restarts. Quota snapshots have separate TTL/freshness rules; historical observed costs do not become invalid merely because five minutes elapsed. Old sessions may support clearly labelled retrospective estimates where route/usage/rates are sufficient, but cannot recover unseen historical billing headers. Expose partial coverage and its start time.

### 3. Existing DSH capabilities and gaps

- [Session stats](../deepseek-harness/packages/client/ui-chat/src/client/chat/StatsPills.tsx#L317-L327) already use durable projections rather than the visible page of chat. Follow that approach for aggregation.
- [Token-usage folding](../deepseek-harness/packages/llm/token-meter/src/usage-projection.ts#L110-L150) replaces repeated usage samples and separates retry attempts. Reuse/test those semantics, not Tau's render-time scan of visible/active-branch messages.
- [Pi usage mapping](../deepseek-harness/packages/llm/llm-pi-ai/src/stream.ts#L18-L31) currently drops pi-ai's calculated monetary fields and some richer pricing dimensions. A dollar value is not already available end-to-end. Pricing an aggregate token total would be wrong for mixed routes, caches, and tariffs.
- The installed OpenAI-completions adapter calculates catalog cost instead of preserving OpenRouter's raw monetary usage field. Its response ID is retained in the [replay envelope](../deepseek-harness/packages/llm/llm-pi-ai/src/replay.ts#L83-L95), making generation-ID lookup a promising no-fork OpenRouter path. Prove that the ID survives actual DSH middleware/settlement in a mocked integration before relying on it. Only query the known provider endpoint with the matching server-side credential; never a URL supplied by model output.
- Prefer native response cost capture when a supported hook exists. Otherwise use bounded, cached generation lookup without blocking model completion; show pending/unknown when unavailable. Never add lookup results to a cost already counted from the response.
- Out-of-tree durable session event extension needs care: [known-event policy](../deepseek-harness/packages/core/session/src/known-event-types.ts#L8-L20) requires unknown events to be explicitly ignorable, but the inspected [append method](../deepseek-harness/packages/core/session/src/index.ts#L719-L747) does not expose an ignorable envelope option. Do **not** append arbitrary required billing events and break session reload. For a no-fork first version, use a plugin-owned versioned append-only ledger under the DSH home plus a plugin-owned snapshot channel. Revisit native event/projection integration only after verifying an omission-safe supported writer contract. Do not edit the generated event catalog.
- The new read endpoint must enforce session ownership and provider-account visibility; knowing a session ID must not grant access to another user's costs or quotas. Unload removes subscriptions/UI, not history; reinstall must not duplicate already settled records.

## Implementation phases and acceptance gates

1. **Fixture-first feasibility.** Prove the current dock placement and popup under Chrome/Safari, keyboard navigation, narrow layouts and mobile hiding; prove no-fork request/attempt correlation, OpenRouter generation ID preservation, credential access through supported host services, and Codex telemetry for each transport. Unsupported cases are explicit, not silently approximated.
2. **Provider-neutral foundation + existing Anthropic evidence.** Build host service, durable ledger, ownership-checked snapshot channel, client pill, source/provenance/coverage labels. Bridge the current passive observer. Validate restart and uninstall safety before trusting a running total.
3. **Money adapters.** Add OpenRouter reported charges with idempotent generation reconciliation and BYOK separation; add API-key estimates only for supported rate-card dimensions. Preserve unpriced gaps. Do not import pi-ai's zero-price defaults as proof that a custom model is free.
4. **OpenAI subscription adapter.** Add dynamic windows/credits and stale handling using the verified native telemetry paths; no API-price-based subscription dollars. Keep unsupported WebSocket or plan shapes explicit until covered.
5. **Isolated preview and explicit promotion.** Use mocks and throwaway/preview homes, without cloud credentials in the standing preview. Tests must not consume paid inference. Present screenshots and the observed fidelity matrix. Live install/rebuild/restart requires separate approval; changing the already-loaded observer's host code can require restart.

Required automated cases: reported zero vs missing; missing rates; cache read/write/TTL; reasoning inclusion; tier/model switch; mixed auth and provider history; named quota windows; stale/account switch; unknown/rejected/429 without invented cost; out-of-order results; cumulative usage replacement; retries; canceled/missing final usage; response plus lookup deduplication; delayed enrichment; title/compaction calls; fork/copy/rewind/compaction; descendant rollup; session ownership; crash/restart/reinstall; observer disabled; UI unloaded; transport unchanged.

## Explicit non-goals for the first version

No invoice certification, automatic OAuth-to-API fallback, spend enforcement, subscription-limit bypass, identity/header spoofing, provider credential exposure, account-balance delta attribution, mandatory administrative billing API access, all-service cloud bill, or reconstruction of uncaptured historical receipts.

See the [existing observer recipe](anthropic-oauth-audit.md) for its present semantics and [preview procedure](../PREVIEWING.md) for safe implementation trials. This plan changes documentation only.
