# Billing status

An **opt-in, out-of-tree** billing observer, request ledger, and compact composer footer. No OAuth command, audit plugin, prompt-excision plugin, or model-picker runtime dependency. No prompt changes, provider-authentication changes, provider polling, generation lookup calls, or forced transport changes.

**Status:** first implementation; offline adapter/transport and isolated UI verification. Not installed into a live profile. This is not an invoice or a provider-neutral subscription guarantee.

## What it shows

| Source | Implemented evidence | Money |
|---|---|---|
| Anthropic OAuth, native HTTP | Accepted subscription-window claim; utilization/reset headers; explicit extra usage; rejected/unknown/unobserved | No conversion of subscription tokens into dollars |
| OpenRouter, native HTTP SSE/JSON | Provider `usage.cost` and generation identity | Reported OpenRouter-account charge, not upstream BYOK charges |
| OpenAI Codex OAuth | `5h`/`7d` windows from ChatGPT's usage endpoint (WebSocket, pi-ai's default transport); over HTTP also each response's primary/secondary windows and credit facts | No dollar conversion; quota observation is **not** an Anthropic-style plan claim |
| API-key routes whose model DSH's catalog prices | Normalized token usage × `ctx.llm.resolveModelInfo(provider, model).pricing` | Versioned **model-token estimate** (`~$`); tools, media and contract discounts aren't priced |
| Unsupported/custom transports | Explicit unobserved evidence | Unknown, never an invented zero |

Only scoped inference requests are observed passively. Subscription readings (5h/7d windows) are account-wide, so the latest accepted reading is remembered per session **and** per subscription route, and written to `quota.json` (0600, newest 512 sessions) beside the ledger. After a restart the previous reading comes back marked stale rather than disappearing; a session on a subscription route with no reading at all shows the shield with `—`, never the API glyph. A session whose requests all predate the ledger has no recorded route, so the client also sends the session's selected route (`modelSelection` projection: next, else last used) as `&route=`; it is used only when nothing is recorded for the session and only picks which account reading to show. `dsh-tailscale-remote` read grants allow that one extra parameter and bind it. A late response from a superseded request updates neither. Staleness is based on server time (default five minutes).

When the **displayed** session needs a reading (none, or only a stale one), the host asks DSH once for the account's current usage through `ctx.llm.subscriptionUsage(route)` (custom fork; implemented for `anthropic-oauth` via Anthropic's usage endpoint and for `openai-codex`/`openai-codex-oauth` via ChatGPT's Codex usage endpoint). That happens at most once per account per process; a failure retries after five minutes or the endpoint's `retry-after`. After that, every model response's own headers keep the reading current, so there is no polling. Where responses carry no reading — Codex over WebSocket, pi-ai's default — a finished request that reported usage marks the account's reading as behind, and the next display of a session on that account reads usage again (at most once a minute per account). An idle account is never re-read. Credentials never pass through this plugin: the model adapter makes the call with its own refreshed token. Codex readings are `quota` (account windows), not `plan` claims; credit facts (Codex HTTP headers only) stay in memory.

### Compact display

| State | Pill |
|---|---|
| OpenRouter-reported cost | OpenRouter glyph + `$1.24` (no qualifier: reported is the default meaning) |
| Token-price estimate from DSH's model catalog | API glyph `[</>]` + `~$2.52` |
| Cost unknown or not observable | API (or OpenRouter) glyph + `$ —`; the reason (for example `2 unpriced requests`) is in the tooltip and card |
| Subscription windows | shield + `5h` ring `7d` ring (ContextMeter ring geometry); the percentages are in the tooltip and card |
| Single unnamed quota (Codex `primary` without a duration) | shield + `20%`; windows with durations get `5h`/`7d` rings |
| Extra usage | shield + orange `Extra`, never a percentage |
| Stale quota | the previous reading stays; its shield and rings are dimmed, orange info icon |
| Gaps (unpriced beside a known cost, incomplete, failed) | trailing orange info icon; hover lists them |
| Request in flight (pending) | nothing on the pill; the card's Requests row reads `53 · 1 in flight` |
| Storage failure, rejected request, access failure | trailing red warning icon; hover lists them |

Amounts are compact display rounding over the host's exact decimals: at most two decimals below 10, one from 10 up, trailing zeros dropped, leading zero omitted after a symbol (`$0`, `$.04`, `$1.24`, `$52.4`, `$1024.1`); a positive amount that rounds to zero reads `<$.01`. `$` means USD: OpenRouter's `usage.cost` carries no currency field and OpenRouter documents USD as its billing currency; estimates use DSH's resolved-model `pricing` (list prices from the installed pi-ai catalog, published by the custom fork's `llm-pi-ai` adapter; see below), which is USD. `EUR`/`GBP` use their symbols, other currencies a code prefix; buckets are never converted or summed across currencies. Money is session history and does not go stale; only quota readings age (default five minutes, server clock).

Clicking opens a card in ContextMeter's panel skin: headline figure, exact per-kind amounts with scope, quota windows with bars and reset times, notes, and request count/model/route/observed time. The OAuth shield and API glyph match the model picker's `RouteIcon` exactly, as local SVG code rather than a runtime import from the picker plugin. No UI help paragraphs.

With `dsh-tailscale-remote` loaded, the snapshot route is authorized per request: the machine's own Tailscale login and authenticated direct loopback callers (the same operator) read every session; other tailnet users need explicit `billingSessionOwners` bindings (see that plugin's README).

### Placement

The plugin registers in `conversation.composer.dock` at order -10, before the session stats (order 0), so billing is **leftmost** in the status area and the context meter stays rightmost, away from billing. Natural DOM order, so visual and keyboard order agree. The earlier CSS `order: 1` experiment (visual order after the meter, keyboard order before it) was rejected for that mismatch.

## Dependencies and coexistence

Host: normal DSH `llm` service. `connection` and `commands` are optional subcontexts. Browser: `slots` plus the normal platform React modules. No other `tali-*` plugin must be enabled. There is no dependency on the `/oauth` command's existence: OAuth transport and credential refresh remain owned by the provider adapter.

Billing and the audit's explicit `mode: observe` use one reference-counted, versioned passive fetch protocol. The [canonical library](../../libraries/passive-fetch/README.md) is shipped as identical generated copies inside each package: no sibling-directory imports or mandatory enabled plugins. They share one wrapper and response-metadata capture while retaining independent async scopes. The OpenRouter parser is selected once and multicasts receipts to billing subscribers. Packed-package and both load/unload-order tests verify this. The audit's separate enforcing branch, settings and defaults are untouched; billing never loads or enables it.

## Durable accounting

- Unique call/attempt identities; native matching HTTP retries are separate attempts. Failed attempts without provider usage remain unpriced.
- Cumulative samples replace previous samples. A receipt replaces a local estimate for the same request; matching provider response IDs prevent receipt duplication within a session.
- Amounts and rates use decimal strings and BigInt arithmetic. Rounding occurs only in the display. Reasoning tokens are already included in output; cache categories require explicit rate-card semantics.
- Auxiliary LLM calls are included when they carry `sessionId`; unattributed calls are not assigned to an arbitrary active chat. Descendants use their own session IDs.
- A plugin-owned append-only ledger is independent of DSH history. Rewind/compaction isn't a refund. Copies/forks don't re-incur inherited costs. There is no historic-session backfill; the UI shows the first observed request time.
- Rate-card versions and monetary results survive reload without repricing history. Quota windows and credit balances do not. In-flight records recovered from an old process are marked incomplete, not indefinitely pending.
- The ledger stores allowlisted metadata/usage/costs only, never prompts, completions, raw headers or credentials; `quota.json` holds only window percentages, reset times, route and model. A file is mode 0600 and its new directory mode 0700.
- A writer lock rejects concurrent writers; existing history is replayed read-only when a lock remains, with an explicit unhealthy-storage state. Corruption, torn final lines, excessive replay size (64 MiB), queue overflow or disk failure makes storage unhealthy and stops further appends rather than silently claiming complete durable totals. Collecting billing must never fail inference.

Files default to `$DSH_HOME/billing-status/ledger.jsonl` and `writer.lock`. This is separate from the session event log: the current session append API cannot mark an external event ignorable. Do not manually inject required billing events into DSH history.

## Read authorization

`GET /api/billing-status/snapshot?sessionId=...` is registered through DSH's authenticated Fetch API. It is document-relative in the client and uses `Cache-Control: no-store`. No HTTP ingestion or account-list endpoint exists.

For a normal single-user DSH composition, the existing DSH browser authentication is the boundary. If the optional `sessionOwners` attribution service exists, the endpoint **fails closed** unless a trusted host service named `billingAccess` (or the optional remote adapter's `sessionRequestAccess`) supplies:

```ts
canRead(request: Request, sessionId: string): boolean | Promise<boolean>
```

Only literal `true` authorizes access. Raw client headers and a guessed session ID aren't proof. Attribution alone is not authorization: the legacy session tracker can observe malformed/rejected requests, so its records are never used as financial permission.

The optional remote adapter checks a verified requester against **explicit operator-configured session-to-login bindings**, not an inferred owner. Its `billingSessionOwners` configuration defaults to `{}` and denies every unbound session. See [remote authorization setup](../dsh-tailscale-remote/README.md#billing-read-authorization). An authenticated direct loopback caller is mapped to the node's known self login; a proxied caller needs an identity admission, not merely a token/QR cookie. A bounded, one-use 256-bit grant binds the exact snapshot request and expires after 15 seconds. Client-supplied copies are stripped by the proxy. No binding is learned from request bodies or historical owner labels.

Once this Cordis root observes ownership-aware services (or the remote adapter marks it), loss of those services **never falls back to single-user access**, including connection/plugin remounts. Independent roots remain independent. Unknown login, unbound session, legacy-only adapter, token-only caller or unavailable authorization produces `Billing unavailable`. This narrowly protects the new snapshot route; it is not a retrofit of multi-tenant security onto all DSH APIs/tools.

Trusted host plugins can consume `ctx.billingStatus.snapshot(sessionId)` or publish allowlisted observations through `ctx.billingStatus.observe(observation)`. There is no browser path to that ingestion method. The optional `/billing` command operates on the calling agent's own session.

## Configuration

All fields are optional.

Counting: a request still in flight is only **pending** (its usage has not arrived). A request that ended in an error or cancellation **before any usage** is counted as **failed (not billed)**, not unpriced: nothing was processed (for example Anthropic's "credit balance is too low" rejection). A request that did process tokens and was then cancelled keeps its usage and is priced normally; one that completed without any usage stays **unpriced**.

### Requests before the ledger (history backfill)

The first time a session is displayed in a process, the host reads its session log (optional `sessionQuery` service) and prices every assistant response that predates the session's first ledger row, skipping subscription routes and events inherited from a fork parent. OpenRouter responses are looked up by generation id through `ctx.llm.responseCost` (custom fork; one request each, at most 500 per session, stopped early by a rate limit or auth failure) and recorded as **reported** charges; when a lookup fails, the catalog estimate is used instead (`~$`, still with the OpenRouter glyph: scope `openrouter-tokens`). Other per-token routes get the catalog estimate. The snapshot that starts a backfill or a subscription usage read waits up to five seconds for it, so the first display already shows the result; if the work takes longer the snapshot carries `refreshing: true` and the pill re-polls after two seconds instead of thirty. Results are appended as `history:<seq>` rows, so a session is backfilled once, not on every restart; a response already recorded live (same generation id, or after the first live row) is never counted twice.

Model ids may contain `~` (OpenRouter's `~vendor/model-latest` aliases); earlier builds rejected them and silently dropped those requests.

### Estimates from DSH's model catalog

With no rate cards, an API-key request is priced from the list prices DSH publishes on resolved model info: the custom fork's `llm-pi-ai` adapter reports the installed pi-ai catalog's rates as `pricing` (input, output, cache read/write per million tokens, optional input-size tiers, USD, source `pi-ai catalog <date>`). Subscription routes (`-oauth`, `openai-codex`) publish none and are never estimated. Each live estimate stores its catalog version (`pi-ai-catalog-<date>`); usage recorded before a price was known is priced at read time from the current catalog and not written back. Lookups are cached per route/model for ten minutes. On a DSH without the `pricing` field, API-key requests stay unpriced (`$ —`). A catalog model without rates, or cache use without a cache rate, stays unpriced rather than assumed free. Anthropic's 1-hour cache-write surcharge is not represented because usage does not distinguish it. An explicit rate card below, when configured, takes precedence.

```yaml
config:
  staleAfterMs: 300000
  # directory: /absolute/path/in/an/isolated/home/billing-status
  rateCards: []
```

A rate card is explicit, immutable for an already-started request, and matches an exact provider/model. This **synthetic example is not a real model's price**:

```yaml
rateCards:
  - provider: openai
    model: fixture-model
    currency: USD
    version: fixture-v1
    source: https://example.com/prices
    inputMode: exclusive
    inputPerMillion: '2'
    outputPerMillion: '8'
    cacheReadPerMillion: '0.2'
    cacheWritePerMillion: '3'
    maxInputTokens: 128000
```

`exclusive` means `inputTokens` excludes cache reads/writes, as required by DSH's normalized `TokenUsage` contract. `inclusive` is rejected: normalizing provider-total input is the adapter's job; subtracting cache here would double-subtract it. Missing cache rates with nonzero cache use make the request unpriced. OAuth routes cannot be assigned API rate cards. Context limits avoid applying a short-context price beyond its known range. Sources must be public HTTPS URLs without embedded credentials or query strings. Token prices do not include hosted-tool calls, multimodal fees or negotiated/provider-account charges.

## Build and tests — no live activation

From this directory:

```sh
pnpm install --ignore-scripts
pnpm typecheck
pnpm build
pnpm test
```

Real DSH/pi-ai tests, **all provider network replaced with fixtures**, from the checkout root:

```sh
node --import tsx/esm --test ../plugins/billing-status/tests/collector-integration.mjs ../plugins/billing-status/tests/integration.mjs ../plugins/billing-status/tests/authorization-integration.mjs
```

The browser fixture and its exact launch command are in [tests/fixture-server.mjs](tests/fixture-server.mjs). It serves mock data and a shell-shaped dock, not another production DSH. No provider credentials are needed. Run only while doing isolated verification, then stop it.

A bundle patch is supplied for a later explicitly approved install. The package has deliberately **not** been added to automatic installation lists or live/dev overlays.

## Limitations and next steps

1. Review and explicitly configure remote session-to-login bindings before rollout. Automatic financial ownership discovery/migration is deliberately unsupported; do not copy unverified attribution records into the access policy.
2. Activate the actual package in an isolated DSH preview before a separately authorized live install. Current browser verification is a mock fixture, not a deployed instance.
3. Codex WebSocket telemetry through a supported hook; never force SSE to obtain billing data. Until then the usage endpoint stands in, so a Codex reading lags a turn by up to one client poll and does not show credits.
4. OpenRouter generation-lookup reconciliation and more complete BYOK reporting; no extra network calls in this version.
5. Maintained rate-card acquisition, actual served-model/service-tier pricing, multimodal and hosted-tool fees. Current estimates price the explicitly configured requested model's normalized tokens only.
6. Ledger compaction/retention and recovery tooling before long-lived high-volume deployments. After a crash, inspect `writer.lock` and confirm no writer exists before removing a stale lock; preserve the ledger. Never delete a lock held by a live instance.

Implementation/verification story: [billing-status recipe](../../recipes/billing-status-plugin.md). Original design: [provider-neutral plan](../../recipes/provider-neutral-billing-status-plan.md).
