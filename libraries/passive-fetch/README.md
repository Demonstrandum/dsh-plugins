# Shared passive fetch capture

This is a dependency-free **code library**, not a Cordis plugin and not an enabled-plugin dependency. Its canonical source is [index.mjs](index.mjs).

The audit and billing packages ship generated, byte-identical copies named `passive-fetch.mjs`. Both copies join a versioned `Symbol.for('tali.passive-fetch-broker.v1')` protocol, so installing either package alone works, and enabling both creates **one passive fetch wrapper and one response-metadata capture**. No sibling directory, symlink dependency or enabled audit plugin is required by billing. The actual packed-package test extracts each npm tarball into an independent temporary directory and imports its host module without the original repository dependencies.

## Updating

Edit the canonical source, then from the repository root:

```sh
node libraries/passive-fetch/sync.mjs
node libraries/passive-fetch/sync.mjs --check
node --test libraries/passive-fetch/shared.test.mjs
```

Do not hand-edit generated copies. They are committed package artifacts so an install never has to generate or import code from a sibling checkout. Runtime code imports its **own local copy** only. The copy check catches drift byte-for-byte.

## Scope and ownership

Each acquisition owns a separate AsyncLocalStorage scope and an idempotent release function. Clearing an unaudited nested audit scope clears only that subscriber, not billing's separately attributed request. Both load orders and both unload orders restore native fetch when the last subscriber releases; an unrelated later wrapper is never overwritten. Disposed subscribers receive no later metadata, including when disposal occurs during a native fetch.

The broker recognizes only reusable, non-coercing dispatch metadata on canonical supported endpoints. It does not read prompts, headers iterators or request streams. Accepted native response metadata is read once, with native property access and redirect checks, then delivered separately. No auth token, request body or raw response body is stored by the library.

Billing may register a bounded demand-driven response parser for OpenRouter. Matching parser protocol keys select one parser and multicast cloned, sanitized evidence to subscribers; no extra reader or clone/tee of the response stream is created. Header-only Anthropic observation leaves response/body identity intact. Observer exceptions do not change inference results.

## Enforcing audit remains separate

Only the existing audit's **observe** mode joins this passive broker. Its explicitly selected **audit** mode retains the original wire validation, user-agent repair, rejection behavior, response handling and independent wrapper. Configuration defaults are unchanged. Billing never enables enforcing audit. Regression tests verify explicit enforcement still blocks invalid requests with billing present in either load order.

## Protocol changes

An incompatible protocol requires a new symbol/version, not reinterpretation of another installed package's v1 state. Compatible fixes can update both generated artifacts together. A broker with an invalid v1 shape is rejected at plugin installation rather than silently overwritten.
