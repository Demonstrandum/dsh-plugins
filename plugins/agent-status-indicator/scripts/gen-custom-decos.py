#!/usr/bin/env python3
"""Regenerate the custom-*.svg decorators (devicon-JS-style solid squares with
tall-narrow bottom-right text). Calibrated against renders of the devicon js/ts
squares (qlmanage previews compared by eye): 3-char text 56/0.66, 4-char 63/0.55,
baseline y=122, right edge x=122. Run from the plugin root."""

def square(label, box, text, size, squeeze, y=122, x=122, weight=700):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<rect width="128" height="128" fill="{box}"/>
<g transform="translate({x},{y}) scale({squeeze},1)"><text x="0" y="0" text-anchor="end" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="{weight}" font-size="{size}" fill="{text}">{label}</text></g>
</svg>
'''

DECOS = {
    'custom-html.svg': square('HTML', '#f16529', '#fff', 63, 0.55),   # devicon html5 lighter orange
    'custom-css.svg':  square('CSS',  '#33a9dc', '#fff', 56, 0.66),   # devicon css3 lighter blue
    'custom-xml.svg':  square('XML',  '#8bc34a', '#323330', 56, 0.66),# material green, JS-style dark text
    'custom-img.svg':  square('IMG',  '#26a69a', '#fff', 56, 0.66),
    'custom-pdf.svg':  square('PDF',  '#d32f2f', '#fff', 56, 0.66),
    'custom-csv.svg':  square('CSV',  '#217346', '#fff', 56, 0.66),
    'custom-diff.svg': square('\u00b1', '#00897b', '#fff', 116, 1.0, y=112),
}

if __name__ == '__main__':
    for name, body in DECOS.items():
        with open(f'src/client/icons/{name}', 'w') as f:
            f.write(body)
        print('wrote', name)
