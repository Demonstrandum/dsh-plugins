/** Browser-safe canonical session-reference URI encoder. */
export function encodeSessionReferenceUri(sessionId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(sessionId))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `dsh-session:${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`
}

/** Canonical Markdown mention consumed by DSH's existing session-reference resolver. */
export function formatSessionReferenceMention(sessionId: string, label: string): string {
  const escaped = label.replaceAll('\\', '\\\\').replaceAll(']', '\\]')
  return `@[${escaped}](${encodeSessionReferenceUri(sessionId)})`
}
