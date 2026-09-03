#!/usr/bin/env python3
"""Regenerate the custom-*.svg decorators (devicon-JS-style solid squares with
tall-narrow bottom-right text). Calibrated against renders of the devicon js/ts
squares (qlmanage previews compared by eye): see per-icon comments; box inset 1.5px, baseline y=116.5 (devicon-measured). Run from the plugin root."""

def square(label, box, text, size, squeeze, spacing, weight, x, y=116.5):
    # Box inset 1.5px like the devicon js/ts squares (125x125 on a 128 canvas).
    # Calibrated against MEASURED devicon js/ts renders (qlmanage + PIL bbox):
    # right margin 10, bottom gap 10, TS glyph height ~57.5 viewBox units.
    # letter-spacing is pre-squeeze; WebKit adds trailing spacing before the
    # end anchor, so x carries a +spacing*squeeze compensation baked into the
    # measured values below.
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<rect x="1.5" y="1.5" width="125" height="125" fill="{box}"/>
<g transform="translate({x},{y}) scale({squeeze},1)"><text x="0" y="0" text-anchor="end" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="{weight}" font-size="{size}" letter-spacing="{spacing}" fill="{text}">{label}</text></g>
</svg>
'''

# Diff: green plus over red minus, no background box (drawn as bars, not text).
DIFF_SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<g fill="#4caf50"><rect x="26" y="30" width="76" height="20" rx="4"/><rect x="54" y="2" width="20" height="76" rx="4"/></g>
<rect x="26" y="100" width="76" height="20" rx="4" fill="#ef5350"/>
</svg>
'''

# ── Unframed glyph decos ────────────────────────────────────────────────────
# CSS: the "CSS" letters from material-icon-theme css.svg (the new CSS logo
# lettering). In the source they are NEGATIVE space in a purple rounded box
# (plus small positive filler bits), so the letters are recovered by mask
# subtraction: white letters-region rect minus box path minus filler path,
# plus a small corner patch where the box's corner radius leaks through the
# rect. Transform fitted/centred by measuring rendered bboxes (see AGENTS.md
# iteration notes). Rendered white; the purple is the registry bg colour.
CSS_FILLER = "M20 18h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 20 22h2v2h2v-2c0-.388-.562-.851-1.254-1.034C20.356 20.34 20 18.84 20 18m-3.254 2.966C14.356 20.34 14 18.84 14 18h-2v-2h-2v8h2v-2h4v2h2v-2c0-.388-.562-.851-1.254-1.034"
CSS_BOX = "M24 4H4v20a4 4 0 0 0 4 4h16.16A3.84 3.84 0 0 0 28 24.16V8a4 4 0 0 0-4-4m2 14h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 26 22v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2Z"

# XML/HTML: the "<>" glyph subpaths extracted from material xml.svg (movetos
# absolutised). Black for xml, white for html; greens/oranges are bg colours.
XML_GLYPH = "M6.12 15.5l3.74 3.74 1.42-1.41-2.33-2.33 2.33-2.33-1.42-1.41zM17.28 15.5l-3.74-3.74-1.42 1.41 2.33 2.33-2.33 2.33 1.42 1.41z"

def css_letters(fill, transform='translate(-40.10,-58.51) scale(6.138)'):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
<g transform="{transform}">
<rect x="7" y="13" width="20" height="14" fill="#fff"/>
<path d="{CSS_BOX}" fill="#000"/>
<path d="{CSS_FILLER}" fill="#000"/>
<rect x="26" y="26" width="2.5" height="2.5" fill="#000"/>
</g></mask></defs>
<rect width="128" height="128" fill="{fill}" mask="url(#m)"/>
</svg>
'''

def xml_glyph(fill, transform='translate(-59.45,-99.58) scale(10.574)'):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<g transform="{transform}"><path d="{XML_GLYPH}" fill="{fill}"/></g>
</svg>
'''

# ── Badge (framed) variants: the same extracted glyphs seated bottom-right in
# a devicon-js/ts-geometry box (125x125 inset 1.5). Transforms measured to the
# JS/TS margins: right margin 10, bottom gap 10; CSS letter height 56 (JS ~58),
# <> glyph height 46.5.
def css_badge(box, fill, s=4.674, tx=-4.93, ty=-4.93):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<rect x="1.5" y="1.5" width="125" height="125" fill="{box}"/>
<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
<g transform="translate({tx},{ty}) scale({s})">
<rect x="7" y="13" width="20" height="14" fill="#fff"/>
<path d="{CSS_BOX}" fill="#000"/>
<path d="{CSS_FILLER}" fill="#000"/>
<rect x="26" y="26" width="2.5" height="2.5" fill="#000"/>
</g></mask></defs>
<rect width="128" height="128" fill="{fill}" mask="url(#m)"/>
</svg>
'''

def glyph_badge(box, fill, s=6.284, tx=8.66, ty=-3.72):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<rect x="1.5" y="1.5" width="125" height="125" fill="{box}"/>
<g transform="translate({tx},{ty}) scale({s})"><path d="{XML_GLYPH}" fill="{fill}"/></g>
</svg>
'''

# ── JS/TS letters extracted from the devicon squares ───────────────────────
# JS letters are a direct positive path (devicon dark #323330); TS letters are
# NEGATIVE space (white backing rect behind a holed blue box), recovered by
# mask subtraction. Fits measured: letters width 116, centred on 128.
JS_LETTERS_D = 'M116.347 96.736c-.917-5.711-4.641-10.508-15.672-14.981-3.832-1.761-8.104-3.022-9.377-5.926-.452-1.69-.512-2.642-.226-3.665.821-3.32 4.784-4.355 7.925-3.403 2.023.678 3.938 2.237 5.093 4.724 5.402-3.498 5.391-3.475 9.163-5.879-1.381-2.141-2.118-3.129-3.022-4.045-3.249-3.629-7.676-5.498-14.756-5.355l-3.688.477c-3.534.893-6.902 2.748-8.877 5.235-5.926 6.724-4.236 18.492 2.975 23.335 7.104 5.332 17.54 6.545 18.873 11.531 1.297 6.104-4.486 8.08-10.234 7.378-4.236-.881-6.592-3.034-9.139-6.949-4.688 2.713-4.688 2.713-9.508 5.485 1.143 2.499 2.344 3.63 4.26 5.795 9.068 9.198 31.76 8.746 35.83-5.176.165-.478 1.261-3.666.38-8.581zM69.462 58.943H57.753l-.048 30.272c0 6.438.333 12.34-.714 14.149-1.713 3.558-6.152 3.117-8.175 2.427-2.059-1.012-3.106-2.451-4.319-4.485-.333-.584-.583-1.036-.667-1.071l-9.52 5.83c1.583 3.249 3.915 6.069 6.902 7.901 4.462 2.678 10.459 3.499 16.731 2.059 4.082-1.189 7.604-3.652 9.448-7.401 2.666-4.915 2.094-10.864 2.07-17.444.06-10.735.001-21.468.001-32.237z'
TS_BOX_D = 'M1.5 63.91v62.5h125v-125H1.5zm100.73-5a15.56 15.56 0 017.82 4.5 20.58 20.58 0 013 4c0 .16-5.4 3.81-8.69 5.85-.12.08-.6-.44-1.13-1.23a7.09 7.09 0 00-5.87-3.53c-3.79-.26-6.23 1.73-6.21 5a4.58 4.58 0 00.54 2.34c.83 1.73 2.38 2.76 7.24 4.86 8.95 3.85 12.78 6.39 15.16 10 2.66 4 3.25 10.46 1.45 15.24-2 5.2-6.9 8.73-13.83 9.9a38.32 38.32 0 01-9.52-.1 23 23 0 01-12.72-6.63c-1.15-1.27-3.39-4.58-3.25-4.82a9.34 9.34 0 011.15-.73L82 101l3.59-2.08.75 1.11a16.78 16.78 0 004.74 4.54c4 2.1 9.46 1.81 12.16-.62a5.43 5.43 0 00.69-6.92c-1-1.39-3-2.56-8.59-5-6.45-2.78-9.23-4.5-11.77-7.24a16.48 16.48 0 01-3.43-6.25 25 25 0 01-.22-8c1.33-6.23 6-10.58 12.82-11.87a31.66 31.66 0 019.49.26zm-29.34 5.24v5.12H56.66v46.23H45.15V69.26H28.88v-5a49.19 49.19 0 01.12-5.17C29.08 59 39 59 51 59h21.83z'

JS_DECO_SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<g transform="translate(-43.10,-59.75) scale(1.423)"><path d="{JS_LETTERS_D}" fill="#323330"/></g>
</svg>
'''

TS_DECO_SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
<g transform="translate(-32.67,-52.00) scale(1.333)">
<rect x="22.67" y="47" width="99.67" height="73.67" fill="#fff"/>
<path d="{TS_BOX_D}" fill="#000"/>
</g></mask></defs>
<rect width="128" height="128" fill="#ffffff" mask="url(#m)"/>
</svg>
'''

# ── PDF trefoil (acrobat swirl) from material pdf.svg ──────────────────────
# The swirl is NEGATIVE space inside the red page path; recovered by mask
# subtraction (base rect over the glyph area minus the page path, plus a
# patch where the fold notch leaks past the rect). White; decoBg is the
# artwork's own red #ef5350. Fit measured: bbox (5.25,7.31)-(17.63,19.59) — base rect must start at y=7, not 8, or the mask flattens the trefoil's top cap.
PDF_PAGE_D = 'M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m4.93 10.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04.5-1.04c.45-.87.78-1.66 1.01-2.4m6.48 3.81c.18-.18.27-.41.28-.66.03-.2-.02-.39-.12-.55-.29-.47-1.04-.69-2.28-.69l-1.29.07-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8-.89.49c-1.2.75-1.77 1.59-1.88 2.12-.04.19-.02.36.05.54l.03.05.48.31.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75 1.03.51 2.24.74 3 .74.44 0 .74-.11.91-.3m-.41-.71.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51.09-.1.13-.1.23-.1 1.4 0 1.8.25 1.9.35M7.83 17c-.65 1.19-1.24 1.85-1.69 2 .05-.38.5-1.04 1.21-1.69zm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12.15.05c.17.24.19.56.09 1.1l-.03.16-.16.82z'

PDF_DECO_SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
<g transform="translate(-43.21,-62.11) scale(9.373)">
<rect x="4" y="7" width="14.5" height="13" fill="#fff"/>
<path d="{PDF_PAGE_D}" fill="#000"/>
<rect x="12.8" y="6.9" width="6.2" height="2.5" fill="#000"/>
</g></mask></defs>
<rect width="128" height="128" fill="#ffffff" mask="url(#m)"/>
</svg>
'''

# ── Image mountain+sun from material image.svg ─────────────────────────────
# Holes inside the teal photo-page path; recovered by mask subtraction with a
# patch over the fold-notch leak (same failure mode as pdf). Black glyph;
# decoBg carries the teal. Fit measured: bbox (3.88,5.94)-(11.94,13.50).
IMG_PAGE_D = 'M8.5 6h4l-4-4zM3.875 1H9.5l4 4v8.6c0 .773-.616 1.4-1.375 1.4h-8.25c-.76 0-1.375-.627-1.375-1.4V2.4c0-.777.612-1.4 1.375-1.4M4 13.6h8V8l-2.625 2.8L8 9.4zm1.25-7.7c-.76 0-1.375.627-1.375 1.4s.616 1.4 1.375 1.4c.76 0 1.375-.627 1.375-1.4S6.009 5.9 5.25 5.9'

IMG_DECO_SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
<g transform="translate(-49.75,-75.83) scale(14.388)">
<rect x="3.5" y="5.5" width="9.5" height="8.6" fill="#fff"/>
<path d="{IMG_PAGE_D}" fill="#000"/>
<rect x="8.3" y="5.3" width="5" height="0.95" fill="#000"/>
</g></mask></defs>
<rect width="128" height="128" fill="#323330" mask="url(#m)"/>
</svg>
'''

DECOS = {
    'custom-img.svg': IMG_DECO_SVG,
    'custom-pdf.svg': PDF_DECO_SVG,
    'custom-js.svg': JS_DECO_SVG,
    'custom-ts.svg': TS_DECO_SVG,
    'custom-css-badge.svg': css_badge('#7e57c2', '#fff'),
    # html badge <> enlarged to the css-badge letter height (57 vs 56 measured)
    'custom-html-badge.svg': glyph_badge('#e34f26', '#fff', s=7.65, tx=-14.77, ty=-29.84),
    'custom-xml-badge.svg': glyph_badge('#8bc34a', '#323330'),
    'custom-css.svg': css_letters('#ffffff'),
    'custom-xml.svg': xml_glyph('#323330'),
    'custom-html.svg': xml_glyph('#ffffff'),
    'custom-diff.svg': DIFF_SVG,
}

def namespace_ids(name, body):
    """Make internal ids unique per file so several icons can be inlined into
    one HTML document without mask/gradient references resolving to the wrong
    element (getElementById is document-global)."""
    stem = name.removesuffix('.svg')
    return body.replace('id="m"', f'id="m-{stem}"').replace("url(#m)", f"url(#m-{stem})")

if __name__ == '__main__':
    for name, body in DECOS.items():
        with open(f'src/client/icons/{name}', 'w') as f:
            f.write(namespace_ids(name, body))
        print('wrote', name)
