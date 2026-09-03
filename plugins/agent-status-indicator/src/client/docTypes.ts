/**
 * Document-type registry: one entry per language / file format the indicator
 * can represent. Fields:
 * - `brand`: the standard-size brand/logo artwork (file under ./icons) — kept
 *   for reference and larger surfaces; mostly unused at runtime. `tint`
 *   renders it as a silhouette (mono/dark artwork); `svgBg` puts a rounded
 *   plate behind it when the original colours vanish on dark.
 * - `deco`: the DECORATOR — the small mark composited into the bottom-right
 *   corner of the file icon. material-icon-theme assets, except js/ts which
 *   are the devicon squares, and custom JS-style solid-colour squares
 *   (custom-*.svg, generated) where material only has document-shaped icons
 *   (img, pdf, diff, csv) or none fit (html, css, xml).
 * - `bg`/`fg` drive the monogram-badge fallback (small size / missing art);
 *   `badgeText` overrides the badge label (json shows '{}').
 * - `exts`: matching file extensions (superset of DSH's LANG_BY_EXTENSION in
 *   packages/fs/tool-fs/src/read-render.ts).
 *
 * Not yet imported by the plugin body — gallery-only while we iterate.
 */
export interface DocType {
  /** Short name, e.g. 'py'. */
  readonly id: string
  /** Long name, e.g. 'python'. */
  readonly name: string
  /** Badge text override; defaults to `id` (e.g. json shows '{}'). */
  readonly badgeText?: string
  /** Brand/logo artwork, standard size (file under ./icons). */
  readonly brand?: string
  /** Silhouette tint for mono/dark brand artwork. */
  readonly tint?: string
  /** Plate colour behind brand artwork that needs a backdrop on dark. */
  readonly svgBg?: string
  /** Decorator mark for the bottom-right of the file icon. */
  readonly deco?: string
  /** Badge background colour. */
  readonly bg?: string
  /** Badge foreground/text colour. */
  readonly fg?: string
  /** Matching file extensions (lowercase, no dot). */
  readonly exts: readonly string[]
}

export const DOC_TYPES: readonly DocType[] = [
  { id: 'py', name: 'python', brand: 'lang-python.svg', deco: 'material-python.svg', bg: '#3776ab', fg: '#ffd43b', exts: ['py'] },
  { id: 'js', name: 'javascript', brand: 'lang-javascript.svg', deco: 'devicon-javascript.svg', bg: '#f7df1e', fg: '#000000', exts: ['js', 'jsx', 'mjs', 'cjs'] },
  { id: 'ts', name: 'typescript', brand: 'lang-typescript.svg', deco: 'devicon-typescript.svg', bg: '#3178c6', fg: '#ffffff', exts: ['ts', 'tsx', 'mts', 'cts'] },
  { id: 'go', name: 'go', brand: 'lang-go.svg', deco: 'material-go.svg', bg: '#00add8', fg: '#ffffff', exts: ['go'] },
  { id: 'html', name: 'html', brand: 'html.svg', deco: 'custom-html.svg', bg: '#e34f26', fg: '#ffffff', exts: ['html', 'htm'] },
  { id: 'css', name: 'css', brand: 'css.svg', deco: 'custom-css.svg', bg: '#7e57c2', fg: '#ffffff', exts: ['css', 'scss', 'less'] },
  { id: 'json', name: 'json', badgeText: '{}', deco: 'material-json.svg', bg: '#4a4a4f', fg: '#ececef', exts: ['json', 'jsonc'] },
  { id: 'toml', name: 'toml', brand: 'toml.svg', deco: 'toml.svg', bg: '#9c4121', fg: '#ffffff', exts: ['toml'] },
  { id: 'yaml', name: 'yaml', brand: 'yaml.svg', tint: '#cb171e', deco: 'material-yaml.svg', bg: '#cb171e', fg: '#ffffff', exts: ['yaml', 'yml'] },
  { id: 'md', name: 'markdown', brand: 'md.svg', tint: '#519aba', deco: 'material-markdown.svg', bg: '#519aba', fg: '#ffffff', exts: ['md', 'markdown', 'mdx'] },
  { id: 'svg', name: 'svg', brand: 'svg.svg', deco: 'svg.svg', bg: '#ffb13b', fg: '#1b1b1d', exts: ['svg'] },
  { id: 'sh', name: 'shell', brand: 'lang-shell.svg', deco: 'material-console.svg', bg: '#4eaa25', fg: '#ffffff', exts: ['sh', 'bash', 'zsh'] },
  { id: 'txt', name: 'text', brand: 'txt.svg', bg: '#6d6d72', fg: '#ffffff', exts: ['txt', 'text'] },
  { id: 'log', name: 'log', brand: 'log.svg', bg: '#afb42b', fg: '#1b1b1d', exts: ['log'] },
  { id: 'exe', name: 'executable', brand: 'exe.svg', bg: '#e64a19', fg: '#ffffff', exts: ['exe', 'msi'] },
  { id: 'tex', name: 'latex', brand: 'tex.svg', deco: 'tex.svg', bg: '#2196f3', fg: '#ffffff', exts: ['tex', 'bib'] },
  { id: 'img', name: 'image', brand: 'image.svg', bg: '#26a69a', fg: '#ffffff', exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'] },
  { id: 'pdf', name: 'pdf', brand: 'pdf.svg', bg: '#d32f2f', fg: '#ffffff', exts: ['pdf'] },
  { id: 'diff', name: 'diff', brand: 'diff.svg', deco: 'custom-diff.svg', bg: '#00897b', fg: '#ffffff', exts: ['diff', 'patch'] },
  { id: 'xml', name: 'xml', brand: 'xml.svg', deco: 'custom-xml.svg', bg: '#8bc34a', fg: '#323330', exts: ['xml'] },
  { id: 'sql', name: 'sql', brand: 'sql.svg', deco: 'sql.svg', bg: '#ffca28', fg: '#1b1b1d', exts: ['sql'] },
  { id: 'ini', name: 'ini', brand: 'ini.svg', deco: 'ini.svg', bg: '#42a5f5', fg: '#1b1b1d', exts: ['ini'] },
  { id: 'csv', name: 'csv', brand: 'csv.svg', bg: '#217346', fg: '#ffffff', exts: ['csv', 'tsv'] },
  { id: 'rb', name: 'ruby', brand: 'lang-ruby.svg', deco: 'material-ruby.svg', bg: '#cc342d', fg: '#ffffff', exts: ['rb'] },
  { id: 'rs', name: 'rust', brand: 'lang-rust.svg', tint: '#f0863b', deco: 'material-rust.svg', bg: '#f0863b', fg: '#000000', exts: ['rs'] },
  { id: 'php', name: 'php', brand: 'lang-php.svg', deco: 'material-php.svg', bg: '#777bb4', fg: '#ffffff', exts: ['php'] },
  { id: 'java', name: 'java', brand: 'java.svg', deco: 'material-java.svg', bg: '#0074bd', fg: '#ffffff', exts: ['java'] },
  { id: 'c', name: 'c', brand: 'c.svg', deco: 'material-c.svg', bg: '#03599c', fg: '#ffffff', exts: ['c', 'h'] },
  { id: 'cpp', name: 'c++', brand: 'cpp.svg', deco: 'material-cpp.svg', bg: '#00599c', fg: '#ffffff', exts: ['cc', 'cpp', 'hpp', 'cxx'] },
  { id: 'kt', name: 'kotlin', brand: 'kotlin.svg', deco: 'material-kotlin.svg', bg: '#7f52ff', fg: '#ffffff', exts: ['kt'] },
  { id: 'swift', name: 'swift', brand: 'swift.svg', deco: 'material-swift.svg', bg: '#f05138', fg: '#ffffff', exts: ['swift'] },
  { id: 'lua', name: 'lua', brand: 'lua.svg', svgBg: '#e9e9ec', deco: 'material-lua.svg', bg: '#000080', fg: '#ffffff', exts: ['lua'] },
  { id: 'cs', name: 'csharp', brand: 'lang-csharp.svg', deco: 'material-csharp.svg', bg: '#68217a', fg: '#ffffff', exts: ['cs'] },
  { id: 'perl', name: 'perl', brand: 'lang-perl.svg', tint: '#9aa7d8', deco: 'material-perl.svg', bg: '#39457e', fg: '#ffffff', exts: ['pl', 'pm'] },
  { id: 'r', name: 'r', brand: 'lang-r.svg', deco: 'material-r.svg', bg: '#276dc3', fg: '#ffffff', exts: ['r'] },
  { id: 'elixir', name: 'elixir', brand: 'lang-elixir.svg', deco: 'material-elixir.svg', bg: '#6e4a7e', fg: '#ffffff', exts: ['ex', 'exs'] },
]
