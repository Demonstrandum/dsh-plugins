# Session Reference Picker

Browser-only DSH plugin adding a session-only `%` reference picker.

## Behavior

- Type `%` in the composer to list ordinary, non-blank, non-archived Sessions other than the current Session.
- Subagent Sessions are excluded.
- Rows use `workspace-name/session-name`, show compact relative activity age (`now`, `2min`, `4h`, `3d`), and are ordered newest activity first.
- `%foo` matches `foo` anywhere in that qualified name, case-insensitively.
- `%foo/bar` matches `foo` in the Workspace name and `bar` in the Session name. Empty halves are useful: `%foo/` selects a Workspace and `%/bar` searches Session names across all Workspaces.
- Selecting a row inserts DSH's canonical session-reference chip; the readable qualified label can change without changing the referenced Session id.

Sessions not registered to a Workspace use their cwd basename. The picker intentionally mirrors the ordinary sidebar by hiding archived Sessions.

## Architecture

The browser half registers one `InputTriggerSource` named `session-reference` with trigger `%`. This relies on the DSH fork's generic single-character punctuation trigger seam in `ui-input-trigger`; candidate policy remains out of tree in this plugin.

## Build and test

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```
