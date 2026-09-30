# OAuth flow names and provider routes

## Public names versus stored routes

The `/oauth` command uses the provider's ordinary flow name, without a credential scope or OAuth suffix:

```text
/oauth available
/oauth activate anthropic
/oauth active
/oauth pending
/oauth cancel anthropic
/oauth deactivate anthropic
```

The selected model provider and stored grant deliberately use different identifiers:

| Purpose | Anthropic example |
|---|---|
| Command flow name | `anthropic` |
| API-key provider route | `anthropic` |
| OAuth provider route | `anthropic-oauth` |
| OAuth credential record | `llm-pi-ai/anthropic-oauth` |

This distinction applies to **every OAuth-capable provider in the installed pi-ai catalog**, not an Anthropic allowlist. At pi-ai 0.87.1 the flow names are `anthropic`, `github-copilot`, `kimi-coding`, `meta`, `openai-codex`, `openrouter`, `radius`, and `xai`. Future catalog additions with OAuth receive the same mapping automatically. Even OAuth-only providers receive the isolated route suffix.

`activate` creates or reuses the suffixed route without changing the ordinary route or API-key record. `deactivate` deletes only the isolated OAuth credential record; the model-settings route remains. `active` reads persisted records, while `pending` reports in-flight attempts. API-key-only providers are not OAuth flows and do not appear in `/oauth available`.

## Code ownership and rename

This change updates the existing fork implementation at the user's explicit request; it does not add a competing out-of-tree OAuth implementation.

- [command-oauth](../deepseek-harness/packages/credentials/command-oauth/README.md) replaces the former command-authorization package. Its npm name is `@deepseek-ai/dsh-command-oauth`, its plugin row id is `command-oauth`, and its public slash-command name remains `oauth`.
- [oauth.ts](../deepseek-harness/packages/llm/llm-pi-ai/src/oauth.ts) replaces the provider login module and exports `registerPiAiOAuthFlows`.
- [catalog.ts](../deepseek-harness/packages/llm/llm-pi-ai/src/catalog.ts) derives OAuth routes from the installed catalog; [provider.ts](../deepseek-harness/packages/llm/llm-pi-ai/src/provider.ts) constructs OAuth-only providers.
- The generic [authorization service](../deepseek-harness/packages/credentials/authorization/README.md) retains its name: it owns provider-neutral flow lifecycle and is not exclusively an OAuth protocol implementation.

Package manifests, the shipped base bundle, dependency lockfile, source aliases, tests, documentation, and generated catalogs follow the rename. User-authored deployment patches that explicitly reference the old command package or row id need the new name when that deployment is updated.

## Authentication and request identity

OAuth routes reject `apiKeyEnv`, `api`, and `baseURL` overrides. They have only the native OAuth handler: missing, invalid, or expired grants do not fall back to the API-key route or environment keys. Existing unsuffixed grants are not moved or deleted automatically; authorize the dedicated route with its short flow name when migrating.

pi-ai transports sometimes branch on the native provider id, notably for Copilot headers. The adapter therefore keeps the suffixed id for authentication and credential storage, restores the native id only for transport dispatch and same-route replay, and records the configured route id in durable replay. Renaming model metadata alone would break this distinction.

Settings hides the key input for catalog-backed OAuth routes, but not arbitrary custom routes whose names happen to end in `-oauth`. The backend catalog remains authoritative about which ids are OAuth aliases.

## Human interaction

Browser callback prompts with their own withdrawal signal remain pending while the callback completes. Preliminary text or selection prompts use the existing user-question UI attached to the invoking agent. The command does not silently select a domain, account, or login method. Its URL wait timer pauses while the human is answering. Secret prompts are refused rather than collected in a general question dialog.

Device-code results show both the verification URL and code. Progress notices do not erase them, and repeating `activate` during a pending attempt returns the same link/code instead of starting another login.

## Offline verification

From the fork checkout:

```sh
pnpm exec vitest run packages/credentials/command-oauth/tests packages/bundle/base/tests/base.spec.ts
pnpm exec vitest run packages/llm/llm-pi-ai/tests/oauth.spec.ts packages/llm/llm-pi-ai/tests/oauth-routes.spec.ts packages/llm/llm-pi-ai/tests/catalog.spec.ts packages/llm/llm-pi-ai/tests/dynamic-config.spec.ts packages/llm/llm-pi-ai/tests/auth.spec.ts packages/llm/llm-pi-ai/tests/adapter.spec.ts
pnpm exec vitest run packages/client/ui-settings-models/tests/provider-form.client.spec.tsx
pnpm exec tsc -b packages/llm/llm-pi-ai packages/credentials/command-oauth packages/client/ui-settings-models --pretty false
node --import tsx/esm --test ../plugins/anthropic-oauth-audit/tests/integration.mjs
```

The command's Loader-composition test boots real plugins from a temporary configuration and mocks only native OAuth login and the human answerer. The route suite derives cases dynamically from the installed provider registry, tests separate storage/refresh/deletion, and checks native transport identity plus alias replay. No real credentials or external OAuth requests are needed.

Build client artifacts into a temporary output directory, or use an isolated checkout for whole-repository builds. Do not run the live checkout's pre-push typecheck blindly: it also rebuilds runtime bundles. The renamed client bundle must register `@deepseek-ai/dsh-command-oauth`, not the former package name.

## Validation outcome

Focused OAuth, command, settings UI, replay, and audit-integration suites passed. The command suite includes a real Loader composition across all eight flows plus prerequisite-question cancellation and timeout coverage. Full `pnpm run typecheck` and `pnpm run build` passed in an isolated worktree; pre-commit checks also passed.

The repository-wide documentation gate is **not fully green**: unrelated existing generated catalogs, translation pairing, exported JSDoc, persistence documentation/history, and the session-title README still fail checks. OAuth-specific README structure and model-experience failures found during that run were corrected and rechecked. The dependency-policy verifier also retains six unrelated unclassified imports in session-log-export; OAuth imports now pass without adding a duplicate-safe export exception.

A fresh verification worktree initially lacked generated Remote declaration files, and symlinks back to the original workspace mixed nominal TypeScript identities. Seeding existing generated declarations and resolving workspace dependencies inside the isolated tree fixed this verification setup; the subsequent full build and typecheck passed without rebuilding the live checkout.

## Rollout and troubleshooting

No live settings, stored credentials, profile installation, or server restart is part of this source change. Ask before deploying. After updating dependencies and rebuilding the intended deployment, restart its Host so it loads the renamed package and new adapter; select the suffixed provider route for OAuth requests. `/oauth` itself still takes only short names. The separate [Anthropic audit plugin](anthropic-oauth-audit.md) remains an explicit opt-in and is not installed by this change.

| Symptom or failed approach | Cause and action |
|---|---|
| `/oauth available` shows suffixed names | The Host is still running the old command module; browser refresh alone does not reload Host source. |
| OAuth overwrites an API-key record | The grant must be written under the resolved suffixed route, never the public command argument. |
| Failed activation leaves an unwanted new profile | Settings expands default fields; rollback compares the observed post-create profile rather than a literal empty object, preserving later user edits. |
| Copilot, Codex, or Radius cancels before giving a URL | These flows ask preliminary questions; the composition needs the user-question service and a connected answerer. |
| Device verification page asks for a missing code | Return the notice's code as well as its URL; keep the last URL-bearing notice across progress updates. |
| API-key or endpoint override rejected on an OAuth route | Use a separate non-OAuth route for these settings. |
| Client package identity mismatch after the rename | Rebuild the client factory with the new package name and update old deployment row references. |
| A lockfile-only install changes unrelated peer-resolution entries | Keep the OAuth importer edits narrow and validate with a frozen lockfile; do not commit unrelated resolver churn. |

Successful OAuth and correct route selection do not establish subscription billing. The audit recipe explains response evidence and the need for provider-side accounting checks.
