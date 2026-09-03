# Icon assets

- `lang-*.svg` — copied from tali's pi-web (`~/github/pi-web/src/client/src/icons/`).
- `html.svg` `css.svg` `md.svg` `yaml.svg` — [devicon](https://github.com/devicons/devicon) (MIT), `*-original` variants.
- `toml.svg` `svg.svg` `txt.svg` `xml.svg` `sql.svg` `ini.svg` `csv.svg` — [material-icon-theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT); txt=document, sql=database, ini=settings, csv=table; plus `log.svg` `exe.svg` `tex.svg` `image.svg` `pdf.svg` `diff.svg`.
- `java.svg` `c.svg` `cpp.svg` `kotlin.svg` `swift.svg` `lua.svg` — [devicon](https://github.com/devicons/devicon) (MIT), `*-original`.

Mono/dark marks (`lang-rust`, `lang-perl`, `md`, `json`) are silhouette-tinted at
render time via the registry's `tint` field (CSS mask), as pi-web does.

- `material-*.svg` — [material-icon-theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT) decorators.
- `devicon-javascript.svg` `devicon-typescript.svg` — devicon (MIT) squares used as js/ts decorators.
- `custom-*.svg` — generated JS-style solid squares (see gen script / AGENTS.md): html #f16529, css #33a9dc,
  xml #8bc34a; diff is a green-plus/red-minus mark with no background.
