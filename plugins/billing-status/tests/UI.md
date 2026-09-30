# Billing browser fixture

This fixture uses the real billing component and the checkout's platform positioning/dismissal hooks. It does not boot DSH, access a DSH home, load provider credentials, or call a model. Its mock request interceptor requires the document-relative endpoint `/fixture/api/billing-status/snapshot`; a leading-slash production fetch fails the fixture.

From this package:

```sh
pnpm typecheck
node --test tests/client.test.mjs
pnpm build
node tests/fixture-server.mjs
```

Open the printed `/fixture/` URL. Optional `PORT` selects a port. The server bundles into memory; restart it after source edits. Only the new plugin's `pnpm build` writes its own `lib/client.js`. Do not run that build against an installed live bundle without deployment permission.

## Browser checks

On a fresh fixture page, evaluate `await window.billingFixture.run()`. This checks:

- Fresh plan windows and the exact shield-with-person glyph.
- Labelled details, dialog focus, Escape and trigger-focus restoration.
- The CSS `order:1` candidate moving pixels without changing DOM order.
- Explicit reported zero, different-session pending state, and misaddressed snapshots.
- Hidden-dock and unmount abort cleanup.
- Forbidden responses clearing account information.
- Stale evidence, quota versus plan semantics, credits versus currency.
- Recovery preserving money but not inventing current quota, incomplete requests.

Controls provide plan, quota, rejected, recovered, reported, mixed, zero, unknown, stale, extra, persistence error, forbidden, delayed and wrong-session states. `window.billingFixture.requests` records requests/aborts. `select(scenario, sessionId?)`, `hide(boolean)`, `mount(boolean)` and `order(boolean)` support additional tests. `run()` is intended for a fresh page.

## Observed results

- Fourteen Node UI tests and the strict TypeScript check pass against the current checkout.
- Twelve fixture checks pass in Chrome.
- Native Chrome Tab goes cache → billing → context, matching the default visual order.
- With `order:1`, billing moves after context visually but stays before it in DOM/tab order. **Production therefore keeps the accessible before-meter fallback**, `order:100` within the existing slot, with no CSS order override, positive tabindex, host DOM reparenting, or private selectors. A true trailing slot would be needed for matching after-meter visual/reading/focus order.
- The test fixture mirrors `InputBar`'s dock/outlet/context structure and 12px gap; it is not a booted DSH application. The real component uses 8px pill padding, 14px glyphs, and existing theme tokens.
- At a true 320px iframe viewport, mixed-state document width stayed 320px, dock scroll width equalled its 272px client width, and the popup stayed between x=12 and x=308. Truncation retains the full accessible label and click details.
- A Safari automation attempt remained `document.visibilityState='hidden'` and did not paint its window. No requests were made, as intended for a hidden document. Safari visual verification remains unverified; the timeout was not treated as a passing browser test.

## Lifecycle and contract

Only `slots` is required by the browser plugin. Runtime imports are React, React DOM, and DSH's platform UI primitives; the conversation and renderer imports are erased types. The style and slot registration dispose with the plugin.

The session-keyed component holds no shared account cache. It validates version/session identity/schema, aborts pending fetches on hide/unmount/session change, polls every 5 seconds while running and 30 seconds while idle, and backs failures off to 60 seconds. Responses use same-origin credentials and `no-store`. No provider credentials enter the browser. Network/authorization failures show `Billing unavailable`, not a cached account claim.

Quota staleness uses the host's optional `now` clock and `staleAfterMs` (default five minutes), plus `latest.stale`; monetary history does not expire with quota. Server snapshot `latest.kind='quota'` means quota evidence, not a plan claim. `credits.balance` is provider credits, never dollars. `counts.incomplete` is visible alongside gaps/pending; `recovered` describes persisted history. `coverageSince` is first captured request, not proof of complete historical coverage.

Host-contract regression tests create a real temporary `BillingLedger`, record an OpenRouter receipt (`scope: openrouter-account`) and configured EUR tariff usage, and feed its actual snapshot through the client validator/formatter. Reported and estimated totals remain sorted, distinct currency buckets; no FX conversion is performed. A persistence error labels the compact total `Partial · Not saved`, since it can represent a damaged replay prefix or missing telemetry as well as an unsaved update.
