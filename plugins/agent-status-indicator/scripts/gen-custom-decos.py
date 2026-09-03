#!/usr/bin/env python3
"""Regenerate the custom-*.svg decorators (devicon-JS-style solid squares with
tall-narrow bottom-right text). Calibrated against renders of the devicon js/ts
squares (qlmanage previews compared by eye): 3-char text 56/0.66, 4-char 63/0.55,
baseline y=120.5, right edge x=120.5, box inset 1.5px (devicon-matched). Run from the plugin root."""

def square(label, box, text, size, squeeze, y=120.5, x=120.5, weight=700):
    # Box inset 1.5px like the devicon js/ts squares (125x125 on a 128 canvas).
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<rect x="1.5" y="1.5" width="125" height="125" fill="{box}"/>
<g transform="translate({x},{y}) scale({squeeze},1)"><text x="0" y="0" text-anchor="end" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="{weight}" font-size="{size}" fill="{text}">{label}</text></g>
</svg>
'''

# Diff: green plus over red minus, no background box (drawn as bars, not text).
DIFF_SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<g fill="#4caf50"><rect x="26" y="30" width="76" height="20" rx="4"/><rect x="54" y="2" width="20" height="76" rx="4"/></g>
<rect x="26" y="100" width="76" height="20" rx="4" fill="#ef5350"/>
</svg>
'''

DECOS = {
    'custom-html.svg': square('HTML', '#f16529', '#fff', 63, 0.55),   # devicon html5 lighter orange
    'custom-css.svg':  square('CSS',  '#33a9dc', '#fff', 56, 0.66),   # devicon css3 lighter blue
    'custom-xml.svg':  square('XML',  '#8bc34a', '#323330', 56, 0.66),# material green, JS-style dark text
    'custom-diff.svg': DIFF_SVG,
}

if __name__ == '__main__':
    for name, body in DECOS.items():
        with open(f'src/client/icons/{name}', 'w') as f:
            f.write(body)
        print('wrote', name)
