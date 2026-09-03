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

DECOS = {
    'custom-css-badge.svg': css_badge('#7e57c2', '#fff'),
    'custom-html-badge.svg': glyph_badge('#e34f26', '#fff'),
    'custom-xml-badge.svg': glyph_badge('#8bc34a', '#323330'),
    'custom-css.svg': css_letters('#ffffff'),
    'custom-xml.svg': xml_glyph('#323330'),
    'custom-html.svg': xml_glyph('#ffffff'),
    'custom-diff.svg': DIFF_SVG,
}

if __name__ == '__main__':
    for name, body in DECOS.items():
        with open(f'src/client/icons/{name}', 'w') as f:
            f.write(body)
        print('wrote', name)
