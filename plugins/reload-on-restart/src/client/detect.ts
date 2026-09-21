/**
 * Pure decision logic: is an incoming client graph the same server the page
 * booted from (possibly with one or two rebuilt bundles), or a NEW server
 * process whose every row revision was re-minted?
 *
 * Facts this relies on (packages/client/modules/src/index.ts in the checkout):
 *   - A row's initial rev is `<random 8-byte hex nonce>-<n>`; the nonce is
 *     drawn once per host process (`initialRevisionNonce`), so a restart
 *     changes EVERY row's rev even when the bundle bytes are identical.
 *   - A genuinely rebuilt bundle gets a content hash rev and is announced one
 *     row at a time (`rebuilt` frame → entries.reload). A graph frame after a
 *     row was added/removed keeps the untouched rows' revs.
 * Hence: "every row we already know changed rev at once" ⇔ server restart.
 */

/** One wire graph row; only the identity and the revision matter here. */
export interface GraphRow {
  readonly id: string
  readonly rev: string
}

export type Verdict =
  /** No known row changed rev (first frame after boot, or rows only added/removed). */
  | { readonly kind: 'unchanged'; readonly common: number }
  /** Some known rows changed — ordinary HMR; let client-hmr hot-swap them. */
  | { readonly kind: 'partial'; readonly changed: number; readonly common: number }
  /** Every known row changed rev at once — the page is talking to a new server process. */
  | { readonly kind: 'restart'; readonly changed: number }
  /** No row in common (nothing to compare). */
  | { readonly kind: 'unrelated' }

/** Read `{ entries: [{ id, rev }] }` from an unknown wire frame; unknown shapes yield []. */
export function graphRows(graph: unknown): GraphRow[] {
  if (typeof graph !== 'object' || graph === null) return []
  const entries = (graph as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return []
  const rows: GraphRow[] = []
  for (const row of entries as unknown[]) {
    if (typeof row !== 'object' || row === null) continue
    const { id, rev } = row as { id?: unknown; rev?: unknown }
    if (typeof id === 'string' && typeof rev === 'string') rows.push({ id, rev })
  }
  return rows
}

/**
 * Compare the incoming rows against the revisions the page currently runs.
 * @param known - row id → rev as last applied in this page.
 * @param incoming - rows of the graph frame just received.
 */
export function classify(known: ReadonlyMap<string, string>, incoming: readonly GraphRow[]): Verdict {
  let common = 0
  let changed = 0
  for (const row of incoming) {
    const current = known.get(row.id)
    if (current === undefined) continue
    common += 1
    if (current !== row.rev) changed += 1
  }
  if (common === 0) return { kind: 'unrelated' }
  if (changed === 0) return { kind: 'unchanged', common }
  if (changed === common) return { kind: 'restart', changed }
  return { kind: 'partial', changed, common }
}
