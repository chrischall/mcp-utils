/**
 * Writing a message body: a Markdown subset to safe HTML. Pure, no
 * dependencies.
 *
 * An agent writes Markdown far more cheaply than HTML (fewer output tokens,
 * and no markup to get wrong), and the caller's text can never smuggle markup
 * in: raw HTML is escaped, and links go only to http(s) or mailto.
 */
import { escapeHtml } from './html.js';

export interface MarkdownOptions {
  /**
   * `:key:` shortcodes: return the HTML for one (e.g. an emoji), or
   * `undefined` to leave it as written. Applied outside code only.
   */
  shortcode?: (key: string) => string | undefined;
  /** Render `# heading` lines as `<h1>`–`<h6>` (default: shown as written). */
  headings?: boolean;
  /** Render `> quoted` lines as a `<blockquote>` (default: shown as written). */
  quotes?: boolean;
}

/*
 * Private-use characters reserved for this renderer's placeholders, stripped
 * from the input so it cannot forge one. Callers may carry placeholders of
 * their own through the renderer in U+E010–U+F8FF: they are passed through as
 * ordinary text.
 */
const HOLE_OPEN = '';
const HOLE_CLOSE = '';
const RESERVED = /[-]/g;

/** Link targets a body may carry. */
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

/**
 * Inline Markdown → HTML: `code`, [text](url) (http, https, mailto only),
 * **bold** / __bold__, *italic* / _italic_, ~~strike~~, backslash escapes,
 * :key: shortcodes, newlines as `<br>`. Everything else is escaped text.
 */
function renderInline(src: string, o: MarkdownOptions): string {
  const holes: string[] = [];
  const hole = (html: string) => `${HOLE_OPEN}${holes.push(html) - 1}${HOLE_CLOSE}`;
  const token =
    /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(\s*([^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\s*\)|\\([\\`*_{}[\]()#+\-.!~>|:])/g;
  let s = src.replace(token, (whole, _ticks, code: string, label: string, href: string, escaped: string) => {
    if (code !== undefined) return hole(`<code>${escapeHtml(code.replace(/^ (.*[^ ].*) $/s, '$1'))}</code>`);
    if (escaped !== undefined) return hole(escapeHtml(escaped));
    if (!SAFE_HREF.test(href)) return whole;
    return hole(`<a href="${escapeHtml(href)}">${renderInline(label, o)}</a>`);
  });
  // Shortcodes before escaping and emphasis, so a key's "_" is never read as italic.
  if (o.shortcode !== undefined) {
    const render = o.shortcode;
    s = s.replace(/:([a-z0-9_+-]+):/g, (whole, key: string) => {
      const html = render(key);
      return html === undefined ? whole : hole(html);
    });
  }
  s = escapeHtml(s)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
    .replace(/(^|[^\w*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br>');
  const fill = new RegExp(`${HOLE_OPEN}(\\d+)${HOLE_CLOSE}`, 'g');
  return s.replace(fill, (_w, n: string) => holes[Number(n)]!);
}

interface ListNode {
  indent: number;
  ordered: boolean;
  start: number;
  items: { lines: string[]; children: ListNode[] }[];
}

const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;

function renderList(list: ListNode, o: MarkdownOptions): string {
  const tag = list.ordered ? 'ol' : 'ul';
  const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
  const items = list.items.map(
    (i) => `<li>${renderInline(i.lines.join('\n'), o)}${i.children.map((c) => renderList(c, o)).join('')}</li>`,
  );
  return `<${tag}${start}>${items.join('')}</${tag}>`;
}

/**
 * Consecutive list lines (items, and indented lines continuing one) as one
 * list, nested by indentation. Returns the HTML and the lines used.
 */
function parseList(lines: readonly string[], from: number, o: MarkdownOptions): { html: string; next: number } {
  const roots: ListNode[] = [];
  const stack: ListNode[] = [];
  let i = from;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const m = LIST_ITEM.exec(line);
    if (m === null) {
      // An indented line continues the last item; anything else ends the list.
      const last = stack.at(-1)?.items.at(-1);
      if (line.trim() !== '' && /^\s/.test(line) && last !== undefined) {
        last.lines.push(line.trim());
        continue;
      }
      break;
    }
    const indent = m[1]!.length;
    const ordered = /\d/.test(m[2]!);
    while (stack.length > 0 && indent < stack[stack.length - 1]!.indent) stack.pop();
    let top = stack.at(-1);
    if (top !== undefined && indent >= top.indent + 2 && top.items.length > 0) {
      const nested: ListNode = { indent, ordered, start: ordered ? Number.parseInt(m[2]!, 10) : 1, items: [] };
      top.items[top.items.length - 1]!.children.push(nested);
      stack.push(nested);
      top = nested;
    } else if (top === undefined || top.ordered !== ordered) {
      const fresh: ListNode = { indent, ordered, start: ordered ? Number.parseInt(m[2]!, 10) : 1, items: [] };
      if (top !== undefined && stack.length > 1) {
        stack.pop();
        stack[stack.length - 1]!.items.at(-1)!.children.push(fresh);
      } else {
        roots.push(fresh);
        stack.length = 0;
      }
      stack.push(fresh);
      top = fresh;
    }
    top.items.push({ lines: [m[3]!], children: [] });
  }
  return { html: roots.map((r) => renderList(r, o)).join(''), next: i };
}

function render(src: string, o: MarkdownOptions, depth: number): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) out.push(`<p>${renderInline(para.join('\n'), o)}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      flush();
      const close = new RegExp(`^ {0,3}${fence[1]![0] === '`' ? '`' : '~'}{${fence[1]!.length},}\\s*$`);
      const code: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]!); i++) code.push(lines[i]!);
      i++; // the closing fence (or past the end)
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      const { html, next } = parseList(lines, i, o);
      out.push(html);
      i = next;
      continue;
    }
    const heading = o.headings === true ? HEADING.exec(line) : null;
    if (heading !== null) {
      flush();
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2]!, o)}</h${level}>`);
      i++;
      continue;
    }
    // Quotes nest by recursion; past a sane depth the rest stays text.
    if (o.quotes === true && depth < 20 && QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length; i++) {
        const q = QUOTE.exec(lines[i]!);
        if (q === null) break;
        quoted.push(q[1]!);
      }
      out.push(`<blockquote>${render(quoted.join('\n'), o, depth + 1)}</blockquote>`);
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line);
    i++;
  }
  flush();
  return out.join('');
}

/**
 * A Markdown subset as HTML: paragraphs (a blank line between them; a single
 * newline is a line break), **bold**, *italic*, ~~strike~~, `inline code`,
 * fenced code blocks, bulleted (`-`, `*`, `+`) and numbered (`1.`) lists
 * nested by indentation, [links](https://…) with their text, and, when
 * enabled, headings, quotes and `:key:` shortcodes. Anything else — raw HTML,
 * images, tables — is escaped and shown as written.
 */
export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  return render(src.replace(/\r\n?/g, '\n').replace(RESERVED, ''), opts, 0);
}
