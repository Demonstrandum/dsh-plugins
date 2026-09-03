/**
 * Document-type registry: one entry per language / file format the indicator
 * can represent. Rendering rules:
 * - `svg` (standard size) / `svgSmall` (compact variant) name files in
 *   ./icons. `tint` renders the SVG as a silhouette in that colour (CSS mask)
 *   for mono/dark artwork (pi-web's TINT idea). `svgBg` puts a rounded plate
 *   of that colour behind the artwork when the original colours need a
 *   backdrop to stay visible on the dark chat background.
 * - `bg`/`fg` drive the monogram-badge fallback (small size or missing svg):
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
  /** Plate colour behind the standard/small SVG when it needs a backdrop. */
  readonly svgBg?: string
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
  { id: 'json', name: 'json', svg: 'json.svg', svgBg: '#e9e9ec', bg: '#55565b', fg: '#f5de19', exts: ['json', 'jsonc'] },
  { id: 'toml', name: 'toml', svg: 'toml.svg', bg: '#9c4121', fg: '#ffffff', exts: ['toml'] },
  { id: 'yaml', name: 'yaml', svg: 'yaml.svg', tint: '#cb171e', bg: '#cb171e', fg: '#ffffff', exts: ['yaml', 'yml'] },
  { id: 'md', name: 'markdown', svg: 'md.svg', tint: '#519aba', bg: '#519aba', fg: '#ffffff', exts: ['md', 'markdown', 'mdx'] },
  { id: 'svg', name: 'svg', svg: 'svg.svg', bg: '#ffb13b', fg: '#1b1b1d', exts: ['svg'] },
  { id: 'sh', name: 'shell', svg: 'lang-shell.svg', bg: '#4eaa25', fg: '#ffffff', exts: ['sh', 'bash', 'zsh'] },
  { id: 'txt', name: 'text', svg: 'txt.svg', bg: '#6d6d72', fg: '#ffffff', exts: ['txt', 'text', 'log'] },
  { id: 'xml', name: 'xml', svg: 'xml.svg', bg: '#8bc34a', fg: '#1b1b1d', exts: ['xml'] },
  { id: 'sql', name: 'sql', svg: 'sql.svg', bg: '#ffca28', fg: '#1b1b1d', exts: ['sql'] },
  { id: 'ini', name: 'ini', svg: 'ini.svg', bg: '#42a5f5', fg: '#1b1b1d', exts: ['ini'] },
  { id: 'csv', name: 'csv', svg: 'csv.svg', bg: '#217346', fg: '#ffffff', exts: ['csv', 'tsv'] },
  { id: 'rb', name: 'ruby', svg: 'lang-ruby.svg', bg: '#cc342d', fg: '#ffffff', exts: ['rb'] },
  { id: 'rs', name: 'rust', svg: 'lang-rust.svg', tint: '#f0863b', bg: '#f0863b', fg: '#000000', exts: ['rs'] },
  { id: 'php', name: 'php', svg: 'lang-php.svg', bg: '#777bb4', fg: '#ffffff', exts: ['php'] },
  { id: 'java', name: 'java', svg: 'java.svg', bg: '#0074bd', fg: '#ffffff', exts: ['java'] },
  { id: 'c', name: 'c', svg: 'c.svg', bg: '#03599c', fg: '#ffffff', exts: ['c', 'h'] },
  { id: 'cpp', name: 'c++', svg: 'cpp.svg', bg: '#00599c', fg: '#ffffff', exts: ['cc', 'cpp', 'hpp', 'cxx'] },
  { id: 'kt', name: 'kotlin', svg: 'kotlin.svg', bg: '#7f52ff', fg: '#ffffff', exts: ['kt'] },
  { id: 'swift', name: 'swift', svg: 'swift.svg', bg: '#f05138', fg: '#ffffff', exts: ['swift'] },
  { id: 'lua', name: 'lua', svg: 'lua.svg', svgBg: '#e9e9ec', bg: '#000080', fg: '#ffffff', exts: ['lua'] },
  { id: 'cs', name: 'csharp', svg: 'lang-csharp.svg', bg: '#68217a', fg: '#ffffff', exts: ['cs'] },
  { id: 'perl', name: 'perl', svg: 'lang-perl.svg', tint: '#9aa7d8', bg: '#39457e', fg: '#ffffff', exts: ['pl', 'pm'] },
  { id: 'r', name: 'r', svg: 'lang-r.svg', bg: '#276dc3', fg: '#ffffff', exts: ['r'] },
  { id: 'elixir', name: 'elixir', svg: 'lang-elixir.svg', bg: '#6e4a7e', fg: '#ffffff', exts: ['ex', 'exs'] },
]
