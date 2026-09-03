/**
 * Document-type registry: one entry per language / file format the indicator
 * can represent. Rendering rules:
 * - `svg` (standard size) / `svgSmall` (compact variant) name files in
 *   ./icons; when `tint` is set the SVG is rendered as a silhouette in that
 *   colour (CSS mask) because the artwork is mono/dark (pi-web's TINT idea).
 * - `bg`/`fg` drive the monogram-badge fallback (and any future colored chip):
 *   background and foreground/text colour, e.g. JavaScript is the classic
 *   yellow badge with black text. (TypeScript's brand is blue/white; the
 *   yellow/black pair belongs to JS.)
 * - `exts` are the file extensions that select this type (superset of DSH's
 *   LANG_BY_EXTENSION in packages/fs/tool-fs/src/read-render.ts).
 *
 * Not yet imported by the plugin body — gallery-only while we iterate.
 */
export interface DocType {
  /** Short name, e.g. 'py'. */
  readonly id: string
  /** Long name, e.g. 'python'. */
  readonly name: string
  /** Standard-size SVG asset (file name under ./icons). */
  readonly svg?: string
  /** Optional compact-size SVG variant. */
  readonly svgSmall?: string
  /** Silhouette tint for mono/dark artwork. */
  readonly tint?: string
  /** Badge background colour. */
  readonly bg?: string
  /** Badge foreground/text colour. */
  readonly fg?: string
  /** Matching file extensions (lowercase, no dot). */
  readonly exts: readonly string[]
}

export const DOC_TYPES: readonly DocType[] = [
  { id: 'py', name: 'python', svg: 'lang-python.svg', bg: '#3776ab', fg: '#ffd43b', exts: ['py'] },
  { id: 'js', name: 'javascript', svg: 'lang-javascript.svg', bg: '#f7df1e', fg: '#000000', exts: ['js', 'jsx', 'mjs', 'cjs'] },
  { id: 'ts', name: 'typescript', svg: 'lang-typescript.svg', bg: '#3178c6', fg: '#ffffff', exts: ['ts', 'tsx', 'mts', 'cts'] },
  { id: 'go', name: 'go', svg: 'lang-go.svg', bg: '#00add8', fg: '#ffffff', exts: ['go'] },
  { id: 'html', name: 'html', svg: 'html.svg', bg: '#e34f26', fg: '#ffffff', exts: ['html', 'htm'] },
  { id: 'css', name: 'css', svg: 'css.svg', bg: '#264de4', fg: '#ffffff', exts: ['css', 'scss', 'less'] },
  { id: 'json', name: 'json', svg: 'json.svg', tint: '#f5de19', bg: '#55565b', fg: '#f5de19', exts: ['json', 'jsonc'] },
  { id: 'toml', name: 'toml', svg: 'toml.svg', bg: '#9c4121', fg: '#ffffff', exts: ['toml'] },
  { id: 'yaml', name: 'yaml', svg: 'yaml.svg', bg: '#cb171e', fg: '#ffffff', exts: ['yaml', 'yml'] },
  { id: 'md', name: 'markdown', svg: 'md.svg', tint: '#519aba', bg: '#519aba', fg: '#ffffff', exts: ['md', 'markdown', 'mdx'] },
  { id: 'svg', name: 'svg', svg: 'svg.svg', bg: '#ffb13b', fg: '#1b1b1d', exts: ['svg'] },
  { id: 'sh', name: 'shell', svg: 'lang-shell.svg', bg: '#4eaa25', fg: '#ffffff', exts: ['sh', 'bash', 'zsh'] },
  { id: 'rb', name: 'ruby', svg: 'lang-ruby.svg', bg: '#cc342d', fg: '#ffffff', exts: ['rb'] },
  { id: 'rs', name: 'rust', svg: 'lang-rust.svg', tint: '#f0863b', bg: '#f0863b', fg: '#000000', exts: ['rs'] },
  { id: 'php', name: 'php', svg: 'lang-php.svg', bg: '#777bb4', fg: '#ffffff', exts: ['php'] },
  { id: 'cs', name: 'csharp', svg: 'lang-csharp.svg', bg: '#68217a', fg: '#ffffff', exts: ['cs'] },
  { id: 'perl', name: 'perl', svg: 'lang-perl.svg', tint: '#9aa7d8', bg: '#39457e', fg: '#ffffff', exts: ['pl', 'pm'] },
  { id: 'r', name: 'r', svg: 'lang-r.svg', bg: '#276dc3', fg: '#ffffff', exts: ['r'] },
  { id: 'elixir', name: 'elixir', svg: 'lang-elixir.svg', bg: '#6e4a7e', fg: '#ffffff', exts: ['ex', 'exs'] },
]
