/**
 * Chrome side of page reads. chrome-devtools-mcp has no text extractor (its
 * `take_snapshot` is the accessibility tree), so the extraction is our own
 * in-page DOM → markdown / plainText / html serializer, and everything else
 * (expand, scope, probe, structure, clean) is the same DOM code page-read.mjs
 * runs in Safari. The bridge is `chromeReadCall`: it makes a Chrome page look
 * like Apple's server to `extractPage` by answering `evaluate_javascript` and
 * `get_page_content` calls with `evaluate_script`.
 *
 * Visibility follows rendering, like WebKit's extractor: elements with
 * display:none / visibility:hidden, or without a rendered box (children of a
 * closed <details>, unselected tab panels), are skipped — which is why
 * `expand` matters here too.
 */

export const CHROME_FORMATS = ['markdown', 'plainText', 'html']

/** Strip chrome-devtools-mcp's "Script ran on page and returned:\n```json\n…\n```" envelope. */
export function unfence(text) {
  const match = /```(?:json)?\n([\s\S]*?)\n```\s*$/.exec(text)
  return match !== null ? match[1] : text
}

/**
 * In-page serializer. Function body; returns `{ url, title, format, content }`.
 * @param {{ format: string, maxWordsPerParagraph: number, includeURLs: boolean }} params
 */
export function chromeExtractScript(params) {
  return `
const P = ${JSON.stringify(params)};
const envelope = (content) => ({ url: location.href, title: document.title, format: P.format, content });
if (P.format === 'plainText') return envelope(document.body.innerText ?? '');
if (P.format === 'html') return envelope(document.body.innerHTML ?? '');

const SKIP = 'script, style, noscript, template, svg, canvas, iframe, object, embed, [hidden], [aria-hidden="true"]';
const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-row-group|table-header-group|table-footer-group|table-caption|flow-root|-webkit-box)$/;
const visible = (el) => {
  if (el === document.body) return true;
  // checkVisibility handles display:none, visibility:hidden and content-visibility:hidden ancestors — which is how
  // Chrome hides the children of a closed <details> (they keep layout boxes, so getClientRects() alone is fooled).
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  if (cs.display === 'contents') return true;
  return el.getClientRects().length > 0;
};
const absolute = (value) => { try { return new URL(value, location.href).href; } catch { return value; } };
const collapse = (text) => text.replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\s+/g, ' ');
const truncate = (text) => {
  if (!(P.maxWordsPerParagraph > 0)) return text;
  const words = text.split(' ');
  return words.length > P.maxWordsPerParagraph ? words.slice(0, P.maxWordsPerParagraph).join(' ') + '…' : text;
};

const out = [];
let line = '';
const flush = () => { const text = collapse(line).trim(); if (text) out.push(truncate(text)); line = ''; };
const blank = () => { flush(); if (out.length > 0 && out[out.length - 1] !== '') out.push(''); };
// Serialize an element's content as one run of inline text. Block children (a div inside an h2 or a) flush
// lines into out; those are folded back into the run so the caller can wrap them (heading marker, link).
const inline = (el, ctx) => {
  const saved = line; line = '';
  const start = out.length;
  for (const child of el.childNodes) walk(child, ctx);
  const nested = out.splice(start).filter((entry) => entry !== '');
  const text = collapse([...nested, line].join(' ')).trim();
  line = saved;
  return text;
};
const headingLevel = (el) => { const m = /^H([1-6])$/.exec(el.tagName); if (m) return Number(m[1]); if (el.getAttribute('role') === 'heading') { const a = Number(el.getAttribute('aria-level')); return a >= 1 && a <= 6 ? a : 2; } return 0; };

function walk(node, ctx) {
  if (node.nodeType === Node.TEXT_NODE) { line += node.data; return; }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node;
  if (el.matches(SKIP) || !visible(el)) return;
  const tag = el.tagName;
  const level = headingLevel(el);
  if (level > 0) {
    blank();
    const text = inline(el, ctx);
    if (text) out.push('#'.repeat(level) + ' ' + text);
    blank();
    return;
  }
  switch (tag) {
    case 'BR': flush(); return;
    case 'HR': blank(); out.push('---'); blank(); return;
    case 'PRE': {
      blank();
      const lang = (el.querySelector('code[class*="language-"]')?.className.match(/language-([\\w-]+)/) ?? [])[1] ?? '';
      out.push('\`\`\`' + lang);
      for (const codeLine of (el.innerText ?? el.textContent ?? '').replace(/\\n$/, '').split('\\n')) out.push(codeLine);
      out.push('\`\`\`');
      blank();
      return;
    }
    case 'CODE': case 'KBD': case 'SAMP': {
      const text = collapse(el.textContent ?? '').trim();
      if (text) line += '\`' + text + '\`';
      return;
    }
    case 'A': {
      const text = inline(el, ctx);
      const href = el.getAttribute('href');
      if (!text) return;
      line += P.includeURLs && href && !/^(javascript:|#$)/.test(href) ? '[' + text + '](' + absolute(href) + ')' : text;
      return;
    }
    case 'IMG': {
      const alt = collapse(el.getAttribute('alt') ?? '').trim();
      if (!alt) return;
      line += P.includeURLs && el.currentSrc ? '![' + alt + '](' + el.currentSrc + ')' : alt;
      return;
    }
    case 'STRONG': case 'B': { const text = inline(el, ctx); if (text) line += '**' + text + '**'; return; }
    case 'EM': case 'I': { const text = inline(el, ctx); if (text) line += '*' + text + '*'; return; }
    case 'INPUT': case 'TEXTAREA': case 'SELECT': return;
    case 'UL': case 'OL': {
      blank();
      let index = tag === 'OL' ? Number(el.getAttribute('start') ?? 1) : 0;
      for (const child of el.children) {
        if (child.tagName !== 'LI' || !visible(child)) continue;
        flush();
        const start = out.length;
        walk(child, { ...ctx, depth: (ctx.depth ?? 0) + 1, item: true });
        flush();
        if (out.length === start) continue;
        const indent = '  '.repeat(ctx.depth ?? 0);
        const marker = tag === 'OL' ? String(index++) + '. ' : '- ';
        out[start] = indent + marker + out[start];
        for (let i = start + 1; i < out.length; i++) if (out[i] !== '' && !/^\\s*(?:-|\\d+\\.) /.test(out[i])) out[i] = indent + '  ' + out[i];
      }
      blank();
      return;
    }
    case 'LI': { for (const child of el.childNodes) walk(child, ctx); return; }
    case 'BLOCKQUOTE': {
      blank();
      const start = out.length;
      for (const child of el.childNodes) walk(child, ctx);
      flush();
      for (let i = start; i < out.length; i++) out[i] = out[i] === '' ? '>' : '> ' + out[i];
      blank();
      return;
    }
    case 'TABLE': {
      blank();
      const rows = [...el.querySelectorAll('tr')].filter((tr) => tr.closest('table') === el && visible(tr));
      let first = true;
      for (const tr of rows) {
        const cells = [...tr.children].filter((cell) => /^T[HD]$/.test(cell.tagName) && visible(cell)).map((cell) => inline(cell, ctx).replace(/\\|/g, '\\\\|'));
        if (cells.length === 0) continue;
        out.push('| ' + cells.join(' | ') + ' |');
        if (first) { out.push('|' + cells.map(() => ' --- |').join('')); first = false; }
      }
      blank();
      return;
    }
    case 'P': case 'FIGCAPTION': case 'DD': case 'DT': case 'ADDRESS': case 'SUMMARY': {
      blank();
      for (const child of el.childNodes) walk(child, ctx);
      blank();
      return;
    }
    default: {
      const block = BLOCK.test(getComputedStyle(el).display);
      if (block) flush();
      for (const child of el.childNodes) walk(child, ctx);
      if (block) flush();
    }
  }
}
walk(document.body, { depth: 0 });
flush();
return envelope(out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim());`
}

/**
 * Adapter that lets page-read.mjs `extractPage` drive a Chrome page: it answers the two Apple-server calls
 * extractPage makes (`evaluate_javascript`, `get_page_content`) with chrome-devtools-mcp's `evaluate_script`.
 * @param {(name: string, args: object) => Promise<string>} callChrome - `conn.callText` with pageId already bound
 */
export function chromeReadCall(callChrome) {
  const run = async (body) => unfence(await callChrome('evaluate_script', { function: `async () => { ${body}\n }` }))
  return async (name, args) => {
    if (name === 'evaluate_javascript') return run(args.expression)
    if (name === 'get_page_content') {
      if (!CHROME_FORMATS.includes(args.format)) throw new Error(`chrome_get_page_content: format must be one of ${CHROME_FORMATS.join(', ')}`)
      return run(chromeExtractScript({ format: args.format, maxWordsPerParagraph: args.maxWordsPerParagraph, includeURLs: args.includeURLs }))
    }
    throw new Error(`chromeReadCall: unsupported call ${name}`)
  }
}
