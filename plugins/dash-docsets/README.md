# tali-dash-docsets

Native DSH tools over [Dash](https://kapeli.com/dash) 8, the macOS
documentation browser: search the docsets you have installed and read their
pages as Markdown. Three tools, host-only, plain ESM JavaScript, no MCP.

| Tool | Does |
|---|---|
| `dash_list_docsets` | installed docsets with the **key** the model uses (`numpy`, `pytorch`, `nlab`, `rust`, …); `details: true` adds version, entry counts per type, a browsable landing-page url and the upstream site |
| `dash_search` | fuzzy symbol/section-name search across all or selected docsets; every result carries a `url` |
| `dash_get_page` | a page — by default just the **section** the url's anchor points at — as Markdown; `section: "outline"` / `"page"` / `"#id"` / heading text / CSS selector |

Full parameter reference (generated): **[`docs/tools.md`](docs/tools.md)**.

## How it talks to Dash

Dash 8 ships a loopback HTTP API server (Dash ▸ Settings ▸ Integration ▸ *API
Server*); Kapeli's own [dash-mcp-server](https://github.com/Kapeli/dash-mcp-server)
is a Python wrapper over it, and this plugin speaks the same endpoints from Node
(`dash.mjs`):

- Port discovery: `~/Library/Application Support/Dash/.dash_api_server/status.json`
  (`{"port": N}`), verified with `GET /health` — Dash leaves a **stale file
  behind when the server is disabled**, so the health check is not optional.
- `GET /docsets/list`, `GET /search?query&docset_identifiers&max_results&search_snippets`.
  Identifiers are opaque 8-letter codes; `docsets.mjs` derives stable keys from
  the docset `platform` / name and resolves what the model passes (`"torch"`,
  `"PyTorch 2.11.0"`, `"usercontribPyTorch"`, `"shofitzl"` all → PyTorch).
- Pages come from a **second** server on another per-launch port
  (`load_url`, e.g. `http://127.0.0.1:53653/Dash/<code>/…#anchor`). Both ports
  are per Dash launch: URLs from an earlier launch fail with an explicit
  "run dash_search again".
- When a tool runs and Dash is not up, it is launched hidden
  (`open -g -j -b com.kapeli.dash-setapp`, then `com.kapeli.dashdoc`; ~1.7 s);
  when the API server is off it is enabled with
  `defaults write <domain> DHAPIServerEnabled -bool YES` (Dash picks it up
  live, ~100 ms). Both are config-gated (`autoLaunch`, `autoEnableApi`).
  Nothing is contacted until a tool is called.

Search semantics (measured on Dash 8.1.1): `/search` matches **symbol and
section names** fuzzily. Body-text hits appear as type `Full-Text Search` for
some docsets (HTML/MDN, NumPy) and not others (PyTorch, Python) even though all
report `full_text_search: enabled` — treat it as a bonus. All 51 docsets at once
answer in ~0.25 s (first call ~4 s cold), so `docsets` defaults to all.
Dash also returns **one row per distinct name** (`torch.transpose` hides
`Tensor.transpose`, as in its UI; the API cannot expand the group — qualify the
query). PyTorch-style docsets return a Method + Guide + Section row per symbol;
`dash_search` collapses rows of one page into the symbol row (`(also Guide,
Section)`) so `maxResults` counts pages.

## Docset details (`docset-info.mjs`)

`dash_list_docsets({ filter, details: true })` (≤ 20 docsets, ~0.3 s each)
reads what the API does not expose, from the docset bundle: `Contents/Info.plist`
via `plutil` (landing page `dashIndexFilePath`, `DashDocSetFallbackURL`,
family) and entry counts per type from `docSet.dsidx` via `/usr/bin/sqlite3`
(two schemas: Dash's `searchIndex`, and Apple's Core Data `ZTOKEN`/`ZTOKENTYPE`
used by the HTML/MDN docset). The landing-page **url** needs the docset's
page-server prefix (`/Dash/<code>/`), which Dash reveals only inside search
results, so one throwaway search learns it; candidates are then GET-verified
because many docsets keep their documents inside `tarix.tgz`. Man Pages'
bundled index is empty (Dash indexes man pages live in `Data/manIndex.dsidx`).
`files:` reports the conventional `Contents/Resources/Documents/` folder when
it exists on disk (nLab, tokio, most generated docsets — `grep`/`read` work
directly on it); feed docsets (PyTorch, NumPy, HTML) are `packed` (`tarix.tgz`)
and reachable only through Dash's server. The result gives the model the true
`types` vocabulary per docset and an entry point for browsing ("what does this
docset cover?"), which name search cannot answer.

Why the probe search stays: Dash's prefs do record the page-server code
(`"DHWebServerFullPath - <docset>/Contents/Resources/Documents/" = yhhfldsx`,
stable across launches), but only for docsets Dash has already served (15 of
51 here), and the page-server **port** is stored nowhere — it appears only in
search-result URLs.

## Page conversion (`html-to-md.mjs`)

Docset pages are static HTML (nLab: 1 MB, 345 `<math>`, zero scripts), so
conversion is in-process — linkedom + turndown, ~20 ms for a Sphinx page,
~125 ms for the 1 MB nLab page — rather than a browser reader:

1. strip chrome: `script/style/nav/aside/footer`, navigation/banner/contentinfo
   roles, `.headerlink`, breadcrumbs, `aria-hidden`, body-level `<header>`;
2. select one region — explicit `section`, else the URL anchor (`#id`,
   Dash-injected `<a name="//apple_ref/…">` / `//dash_ref_<id>/…` anchors), else
   the main landmark when it holds ≥ 60 % of the text. A heading extends to the
   next heading of equal/higher level (Sphinx `<section>` wrappers understood);
   a `dt` takes its `dl`; a bare rustdoc header anchor grows into its
   `<details>` body; an unknown `section` throws **with the page outline**;
3. render: MathML → `$LaTeX$` (embedded TeX `annotation` preferred — KaTeX pages
   would otherwise double every formula — and Unicode math letters folded back
   to `\mathcal{C}`, `\mathbb{R}`, plain italics), Sphinx `\(…\)` spans raw,
   `<pre>` → fenced with the language from `highlight-*`/`language-*` classes,
   Sphinx signatures as bold code + field lists as `**name** (type)`,
   admonitions as quotes, GFM tables, links resolved to absolute URLs (so a
   link in a page is itself a valid `dash_get_page` url), SVG → `[diagram]`.

Output over `maxChars` (60 000 default) is cut and the full text saved to
`$TMPDIR/dsh-dash-page-*.md`; the header tells the model to `read` it or to
ask for `section: "outline"` and pick a section.

## Install

Dev overlay (`../../cordis.dev.yml`) or a row in a profile's patch layer:

```yaml
- insert:
    - id: tali-dash-docsets
      name: '/Users/USER/github/tali-dash-plugins/plugins/dash-docsets/index.js'
      # config:                      # all optional, defaults shown
      #   autoLaunch: true
      #   autoEnableApi: true
      #   bundleIds: [com.kapeli.dash-setapp, com.kapeli.dashdoc]
      #   defaultsDomains: [com.kapeli.dash-setapp, com.kapeli.dashdoc]
      #   maxChars: 60000
      #   defaultMaxResults: 20
      #   docsetCacheSeconds: 300
      #   requestTimeoutMs: 30000
      #   traceFile: /tmp/dash-docsets-trace.log
```

Tools are registered globally (no per-session state), so subagents get them
too. Module changes need a host restart.

## Checks

- `pnpm run check` — offline: config, key derivation/resolution on the saved
  docset list, details on a missing bundle (null-safe), fragment parsing, math folding, the converter on saved PyTorch
  and nLab pages (anchor / page / outline / section-by-id / by-text /
  apple_ref / html format), and all three tools against a fake Dash client
  (grouping, type filter, truncation + spill, error messages, lossless-JSON
  values); plus `docs/tools.md` freshness.
- `pnpm run live [query] [docset]` — the real tool executes against the running
  Dash (list, search variants, PyTorch/nLab/HTML pages, error paths).
- `pnpm run docs` — regenerate `docs/tools.md` after changing a tool.

## Gotchas learned the hard way

- **Tool values must be lossless JSON** — an `undefined` field (`scope.label`)
  made DSH reject `dash_get_page` with `value is not lossless JSON` in a real
  host while every offline test passed. Optional fields are `null`; the check
  script now walks every value.
- turndown-plugin-gfm's table rule needs `table.rows`, which linkedom's DOM
  lacks — hand turndown the **HTML string** (it re-parses with domino), not
  linkedom nodes. Inside domino, `<math>` has a lowercase `nodeName`.
- turndown drops text-less elements as "blank" **before rules run**, so SVG
  placeholders must be swapped into the DOM beforehand; and its escaping turns
  `[diagram]` into `\[diagram\]` — undone in `tidy`.
- Dash returns `max_results + 1` rows, `[{}]` for no results, 400/403 as HTML
  pages (`<h1>` holds the message), and 501 for unknown endpoints.
- `defaults read com.kapeli.dash-setapp DHAPIServerEnabled` "does not exist"
  until it has been toggled once; absence means off.
