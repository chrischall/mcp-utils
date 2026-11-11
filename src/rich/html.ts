/**
 * Reading an HTML message body: a tolerant parse, then a sanitised HTML
 * rendering, plain text, Markdown, or the list of links. Pure functions, no
 * I/O, no dependencies.
 *
 * Message bodies (chat messages, mail) are a loose subset of HTML, so a small
 * forgiving parser is enough. What it does not know it drops, keeping the text
 * inside, so nothing a sender wrote is lost and no markup this module did not
 * choose gets through.
 *
 * Hardened for hostile input (mail is written by anyone): every regex is
 * linear (a tag's attributes can never run past the next `<`), nesting deeper
 * than {@link MAX_DEPTH} is flattened rather than recursed into, and content
 * the sender hid from the reader (`display:none`, `hidden`, …) is dropped by
 * default — it costs tokens and is a classic place to hide instructions.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** HTML character references decoded, in one pass (so `&amp;lt;` becomes `&lt;`, not `<`). */
export function decodeEntities(s: string): string {
  // The legacy references browsers also decode WITHOUT a semicolon (`&nbsp`),
  // except where a letter, digit or `=` follows (`&ampersand`, `&amp=1`) — the
  // rule HTML applies inside attributes, kept here so a word is never cut.
  return s.replace(/&(?:#(\d{1,8})|#x([0-9a-f]{1,8})|([a-z]{1,10}));|&(amp|lt|gt|quot|nbsp)(?![a-z0-9=])/gi, (whole, dec, hex, name, legacy) => {
    if (legacy !== undefined) return NAMED_ENTITIES[legacy.toLowerCase()]!;
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    if (!Number.isFinite(code) || code > 0x10ffff) return whole;
    // Drop control characters (keeping tab/newline): they carry no text and
    // would collide with the placeholders the renderers use.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) return '';
    return String.fromCodePoint(code);
  });
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `s` safe as element text or inside a quoted attribute. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** A tag's attribute, as written (entities NOT decoded); `undefined` when absent. */
export function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** An element of a parsed body. `attrs` is the raw attribute text; read it with {@link attr}. */
export interface RichElement {
  readonly tag: string;
  readonly attrs: string;
  readonly children: readonly RichNode[];
}
/** A string is raw (still entity-encoded) text. */
export type RichNode = string | RichElement;

/** The renderings a hook can be asked for. */
export type RichOutput = 'html' | 'text' | 'markdown';

export interface HtmlReadOptions {
  /**
   * Override how an element reads. Called for every element (and every
   * `<img>`) with the output being produced and the element's content already
   * rendered for that output (`''` for an image); return the replacement, or
   * `undefined` for the default. For `'html'` the return is inserted as-is, so
   * escape anything taken from the element. Teams uses this to keep @mention
   * spans and to show emoji images as their character.
   */
  element?: (el: RichElement, output: RichOutput, inner: string) => string | undefined;
  /**
   * Keep content the sender hid from the reader. By default an element styled
   * `display:none`, `visibility:hidden` or `mso-hide:all`, or carrying the
   * `hidden` attribute, is dropped with everything inside it.
   */
  keepHidden?: boolean;
  /**
   * {@link htmlToText} only: keep one blank line between paragraphs and other
   * blocks, and for a `<br><br>`, collapsing runs of them (default false:
   * every blank line is dropped, the compact form mail reads best in).
   */
  paragraphs?: boolean;
}

export interface SanitiseOptions extends HtmlReadOptions {
  /**
   * Keep only these tags (lower case); any other element is removed and its
   * text kept, as unknown tags already are. The `element` hook runs first, so
   * it can map a tag into the set (`strong` → `<b>`). For hosts that store
   * only a subset: `sanitiseHtml(renderMarkdown(md), { tags, element })`.
   */
  tags?: ReadonlySet<string> | readonly string[];
}

/**
 * Invisible format characters (zero-width space, non-joiner, word joiner,
 * byte-order mark), dropped from text and Markdown output but never from
 * code. The zero-width JOINER (U+200D) is kept: it binds emoji sequences
 * (👩‍💻), and dropping it would split them.
 */
const INVISIBLE = /[\u200b\u200c\u2060\ufeff]/g;
const visible = (s: string): string => s.replace(INVISIBLE, '');

/**
 * One render's state: the caller's options plus, per output, each children
 * list already rendered. Every path to a subtree (a hook reading `inner`, a
 * list or table renderer reading its items) then renders it once, so a render
 * stays linear in the body however it nests.
 */
interface Ctx extends HtmlReadOptions {
  textMemo?: WeakMap<readonly RichNode[], string>;
  mdMemo?: WeakMap<readonly RichNode[], string>;
}

/** Nesting deeper than this is flattened, so a hostile body cannot exhaust the stack. */
export const MAX_DEPTH = 200;

const VOID = new Set(['br', 'img', 'hr', 'wbr', 'input', 'meta', 'link', 'col', 'source', 'area', 'base', 'embed', 'param', 'track']);
const DROPPED_WITH_CONTENT = 'script|style|head|title|template|noscript|iframe|object|svg|math|xml';
const BLOCK = new Set(['p', 'div', 'ul', 'ol', 'pre', 'blockquote', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// Attributes never span a `<`, so a failed match costs at most the distance to the next tag.
const TAG = /<(\/?)([a-z][a-z0-9]*)\b((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>/gi;
const HIDDEN_STYLE = /(?:^|[;\s])(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\b/i;

function isHidden(attrs: string): boolean {
  // The `hidden` attribute is matched among attribute NAMES: quoted values
  // ("Reveal hidden fees") are blanked first.
  const names = attrs.replace(/"[^"]*"|'[^']*'/g, '""');
  if (/(?:^|\s)hidden(?:\s|=|\/|$)/i.test(names)) return true;
  const style = attr(attrs, 'style');
  return style !== undefined && HIDDEN_STYLE.test(decodeEntities(style));
}

interface MutableElement {
  tag: string;
  attrs: string;
  children: RichNode[];
}

/**
 * A forgiving parse into a tree: unknown nesting is closed, stray closing
 * tags are ignored, comments and script/style-like elements go with their
 * content, and (unless `keepHidden`) so do hidden elements.
 */
export function parseHtml(html: string, opts: { keepHidden?: boolean } = {}): RichElement {
  const root: MutableElement = { tag: '#root', attrs: '', children: [] };
  const stack: MutableElement[] = [root];
  const top = () => stack[stack.length - 1]!;
  const src = html
    .replace(/[\u0001-\u0005]/g, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, '')
    .replace(/<![^>]*>/g, '')
    .replace(new RegExp(`<(${DROPPED_WITH_CONTENT})\\b[\\s\\S]*?(?:<\\/\\1\\s*>|$)`, 'gi'), '');
  let at = 0;
  for (const m of src.matchAll(TAG)) {
    if (m.index > at) top().children.push(src.slice(at, m.index));
    at = m.index + m[0].length;
    const tag = m[2]!.toLowerCase();
    if (m[1] === '/') {
      let i = stack.length - 1;
      while (i > 0 && stack[i]!.tag !== tag) i--;
      if (i > 0) stack.length = i;
      continue;
    }
    // Implicit closes HTML itself makes: a new item, cell or row ends the
    // last, and a block ends a paragraph.
    if ((tag === 'li' && top().tag === 'li') || (BLOCK.has(tag) && top().tag === 'p')) stack.pop();
    if ((tag === 'td' || tag === 'th' || tag === 'tr') && (top().tag === 'td' || top().tag === 'th')) stack.pop();
    if (tag === 'tr' && top().tag === 'tr') stack.pop();
    const attrs = m[3]!;
    const el: MutableElement = { tag, attrs, children: [] };
    const hidden = opts.keepHidden !== true && isHidden(attrs);
    // A hidden element is never attached, so whatever is parsed into it is discarded.
    if (!hidden) top().children.push(el);
    const opens = !VOID.has(tag) && !attrs.trimEnd().endsWith('/');
    if (opens && (hidden || stack.length <= MAX_DEPTH)) stack.push(el);
  }
  if (at < src.length) top().children.push(src.slice(at));
  return root;
}

/** A link target this module passes on: http(s) or mailto, decoded; `undefined` otherwise. */
export function safeHref(attrs: string): string | undefined {
  const raw = attr(attrs, 'href');
  if (raw === undefined) return undefined;
  const href = decodeEntities(raw).trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : undefined;
}

/** An image with no override: its alt text in brackets, or nothing (spacers and tracking pixels say nothing). */
function defaultImageText(el: RichElement): string {
  const alt = decodeEntities(attr(el.attrs, 'alt') ?? '').replace(/\s+/g, ' ').trim();
  return alt === '' ? '' : `[${alt}]`;
}

/** Tags kept as they are, with no attributes. */
const PLAIN_TAGS = new Set([
  'p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ul', 'li', 'code', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr',
]);

function serialise(nodes: readonly RichNode[], o: HtmlReadOptions, allow?: ReadonlySet<string>): string {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') {
      out += n.replace(/\r\n?/g, '\n').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      continue;
    }
    const inner = n.tag === 'img' ? '' : serialise(n.children, o, allow);
    const hooked = o.element?.(n, 'html', inner);
    if (hooked !== undefined) out += hooked;
    else if (n.tag === 'img') out += escapeHtml(defaultImageText(n));
    else if (allow !== undefined && !allow.has(n.tag)) out += inner;
    else if (n.tag === 'br' || n.tag === 'hr') out += `<${n.tag}>`;
    else if (PLAIN_TAGS.has(n.tag)) out += `<${n.tag}>${inner}</${n.tag}>`;
    else if (n.tag === 'ol') {
      const start = attr(n.attrs, 'start');
      out += `<ol${start !== undefined && /^\d{1,9}$/.test(start) ? ` start="${start}"` : ''}>${inner}</ol>`;
    } else if (n.tag === 'a') {
      const href = safeHref(n.attrs);
      out += href !== undefined ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
    } else out += inner;
  }
  return out;
}

/**
 * A body reduced to plain formatting: paragraphs, line breaks, bold, italic,
 * underline, strike, lists, links (http, https, mailto), inline code and code
 * blocks, quotes, headings, rules and tables. Every attribute but a link's
 * href and a list's start is dropped; scripts, styles, comments and hidden
 * content go with their content; any other tag goes but its text stays.
 * Images become `[alt]`, or nothing without alt text.
 */
export function sanitiseHtml(html: string, opts: SanitiseOptions = {}): string {
  const allow = opts.tags === undefined ? undefined : new Set([...opts.tags].map((t) => t.toLowerCase()));
  return serialise(parseHtml(html, opts).children, opts, allow);
}

/** Any tag in sanitised HTML beyond paragraphs and line breaks. */
const FORMATTING = /<(?!\/?(?:p|div|br)>)[a-z]/i;

/** True when `html` carries any formatting beyond paragraphs and line breaks. */
export function isRichHtml(html: string, opts: HtmlReadOptions = {}): boolean {
  return FORMATTING.test(sanitiseHtml(html, opts));
}

/** A link in a body, with the text it was shown as. */
export interface RichLink {
  href: string;
  text: string;
}

function walk(nodes: readonly RichNode[], visit: (el: RichElement) => void): void {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    visit(n);
    walk(n.children, visit);
  }
}

/**
 * An element's text on one line, for a link label: the plain-text reading
 * (same hooks, entities, code and invisible-character rules as
 * {@link htmlToText}), its line breaks and blocks as single spaces.
 */
function textOf(nodes: readonly RichNode[], o: Ctx): string {
  return toText(nodes, o).replace(/[\u0001-\u0005]/g, ' ').replace(/\s+/g, ' ').trim();
}

function links(root: RichElement, o: Ctx): RichLink[] {
  const out: RichLink[] = [];
  const seen = new Set<string>();
  walk(root.children, (el) => {
    if (el.tag !== 'a') return;
    const href = safeHref(el.attrs);
    if (href === undefined) return;
    const text = textOf(el.children, o);
    const key = `${href}\n${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ href, text });
  });
  return out;
}

/** Every http(s)/mailto link in a body with its shown text, in order, each pair once. */
export function linksOf(html: string, opts: HtmlReadOptions = {}): RichLink[] {
  return links(parseHtml(html, opts), { ...opts });
}

/**
 * What a read shows of a body's structure, from one parse: its sanitised HTML
 * when it carries formatting (`undefined` for a plain body, whose text says
 * everything), and its links.
 */
export function bodyStructure(html: string, opts: HtmlReadOptions = {}): { contentHtml?: string; links: RichLink[] } {
  const root = parseHtml(html, opts);
  const sanitised = serialise(root.children, opts);
  return { ...(FORMATTING.test(sanitised) ? { contentHtml: sanitised } : {}), links: links(root, { ...opts }) };
}

/* ----------------------------------------------------------------------------
 * Plain text
 * ------------------------------------------------------------------------- */

/*
 * Line markers that survive until the lines are laid out, so a quote's depth
 * applies to every line inside it. `parseHtml` strips them from the input, so
 * a body cannot forge one.
 */
const QUOTE_OPEN = '\u0001';
const QUOTE_CLOSE = '\u0002';
/** A paragraph boundary: a blank line with `paragraphs`, nothing without. */
const PARA = '\u0004';
/** Opens the line a `<br>` starts, so a line holding only it is a `<br><br>` (a paragraph break). */
const BR = '\u0005';
const MARKS = /[\u0004\u0005]/g;
const paraBlock = (inner: string): string => `\n${PARA}\n${inner}\n${PARA}\n`;

/** Elements that are paragraphs of text. */
const TEXT_BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'hr']);

/** A label that is itself an address (a pasted, often clipped link): the href alone says it. */
const LOOKS_LIKE_ADDRESS = /^(https?:\/\/|www\.)/i;

/** A link as text: `label (url)`, or the address alone when that is all it shows. */
function linkText(el: RichElement, label: string): string {
  // Only http(s)/mailto targets are shown, as in Markdown and linksOf.
  const url = safeHref(el.attrs);
  if (url === undefined) return label;
  const shown = label.trim();
  if (shown === '' || shown === url || LOOKS_LIKE_ADDRESS.test(shown)) return url;
  return `${label} (${url})`;
}

/** One table row on one line, its cells joined by ` | ` (line breaks in a cell become spaces). */
function rowText(tr: RichElement, o: Ctx): string {
  const cells = tr.children.filter((n): n is RichElement => typeof n !== 'string' && (n.tag === 'td' || n.tag === 'th'));
  if (cells.length === 0) return toText(tr.children, o);
  const raw = cells.map((c) => toText(c.children, o));
  // A row with one filled cell is layout: its lines (lists, nested tables, quotes) stay lines.
  const filled = raw.filter((t) => t.replace(/[\s\u0001-\u0005]+/g, '') !== '');
  if (filled.length === 1) return filled[0]!;
  const texts = raw.map((t) => t.replace(/[\n\u0001-\u0005]+/g, ' ').trim());
  // Trailing empty cells say nothing; inner ones keep the columns aligned.
  while (texts.length > 0 && texts[texts.length - 1] === '') texts.pop();
  return texts.join(' | ');
}

function toText(nodes: readonly RichNode[], o: Ctx): string {
  const memo = (o.textMemo ??= new WeakMap());
  const hit = memo.get(nodes);
  if (hit !== undefined) return hit;
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') {
      out += visible(decodeEntities(n));
      continue;
    }
    if (n.tag === 'br') {
      out += `\n${BR}`;
      continue;
    }
    // Code keeps its characters as written, invisible ones included.
    const code = n.tag === 'code' || n.tag === 'pre';
    const inner = n.tag === 'img' ? '' : code ? codeText(n.children) : toText(n.children, o);
    const hooked = o.element?.(n, 'text', inner);
    if (hooked !== undefined) out += hooked;
    else if (n.tag === 'img') out += defaultImageText(n);
    else if (n.tag === 'a') out += linkText(n, inner);
    else if (n.tag === 'tr') out += `\n${rowText(n, o)}\n`;
    else if (n.tag === 'blockquote') out += paraBlock(`${QUOTE_OPEN}\n${inner}\n${QUOTE_CLOSE}`);
    else if (n.tag === 'ol' || n.tag === 'ul') {
      const start = Number(attr(n.attrs, 'start'));
      let i = n.tag === 'ol' && Number.isInteger(start) && start >= 0 ? start : 1;
      let items = '';
      for (const c of n.children) {
        if (typeof c !== 'string' && c.tag === 'li') {
          // An item that opens with a block (`<li><p>`) keeps its text on the marker's line.
          const text = toText(c.children, o).replace(/^[\s\u0004\u0005]+|[\s\u0004\u0005]+$/g, '');
          items += `\n${n.tag === 'ol' ? `${i++}. ` : '- '}${text}\n`;
        } else items += toText([c], o);
      }
      out += paraBlock(items);
    } else if (n.tag === 'pre' || TEXT_BLOCK.has(n.tag)) out += paraBlock(inner);
    else if (n.tag === 'li') out += `\n${inner}\n`;
    else out += inner;
  }
  memo.set(nodes, out);
  return out;
}

/**
 * A body as readable plain text. Links keep their target as `text (url)`,
 * images become `[alt]` (or nothing), a numbered list's items `1. `, `2. ` …
 * and a bulleted one's `- `, a table row one line of ` | `-separated cells,
 * and a quote's lines are prefixed `> `. Blank lines are dropped. Never
 * truncated: a long body comes back whole.
 */
export function htmlToText(html: string, opts: HtmlReadOptions = {}): string {
  const out: string[] = [];
  const paragraphs = opts.paragraphs === true;
  let depth = 0;
  let lastDepth = 0;
  let pendingBreak = false;
  // A fresh context per call: the memo must never outlive (or leak into) the caller's options.
  for (const raw of toText(parseHtml(html, opts).children, { ...opts }).split(/\r?\n/)) {
    const line = raw.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (line === QUOTE_OPEN) depth++;
    else if (line === QUOTE_CLOSE) depth = Math.max(0, depth - 1);
    else if (line === PARA || line === BR) pendingBreak = paragraphs && out.length > 0;
    else {
      const text = line.replace(MARKS, '').trim();
      if (text === '') continue;
      // One blank line however many breaks ran together; inside a quote it keeps the quote's `>`.
      if (pendingBreak) out.push('> '.repeat(Math.min(depth, lastDepth)).trimEnd());
      pendingBreak = false;
      out.push(`${'> '.repeat(depth)}${text}`);
      lastDepth = depth;
    }
  }
  return out.join('\n');
}

/* ----------------------------------------------------------------------------
 * Markdown
 * ------------------------------------------------------------------------- */

/** Code blocks wait here while whitespace is tidied, so their indentation survives. */
const CODE_HOLE = '\u0003';
const block = (s: string): string => `\n\n${s}\n\n`;

function wrap(marker: string, inner: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return m[2] === '' ? inner : `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
}

/** Text with `<br>` as newlines and whitespace kept, for code. */
function codeText(nodes: readonly RichNode[]): string {
  return nodes
    .map((n) => (typeof n === 'string' ? decodeEntities(n) : n.tag === 'br' ? '\n' : codeText(n.children)))
    .join('');
}

function inlineCode(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const tidyInner = (s: string): string => s.replace(/\n{3,}/g, '\n\n').trim();

function list(el: RichElement, codes: string[], o: Ctx): string {
  const ordered = el.tag === 'ol';
  const startAttr = Number(attr(el.attrs, 'start'));
  const start = ordered && Number.isInteger(startAttr) && startAttr >= 0 ? startAttr : 1;
  const items = el.children.filter((n): n is RichElement => typeof n !== 'string' && n.tag === 'li');
  return items
    .map((li, i) => {
      const marker = ordered ? `${start + i}. ` : '- ';
      const lines = md(li.children, codes, o).replace(/\n{2,}/g, '\n').trim().split('\n');
      return lines.map((l, n) => (n === 0 ? marker + l : l === '' ? '' : ' '.repeat(marker.length) + l)).join('\n');
    })
    .join('\n');
}

/** A table's own rows: through thead/tbody/tfoot, but never into a nested table (its cell renders that). */
function rowsOf(el: RichElement): RichElement[] {
  const out: RichElement[] = [];
  for (const n of el.children) {
    if (typeof n === 'string') continue;
    if (n.tag === 'tr') out.push(n);
    else if (n.tag === 'thead' || n.tag === 'tbody' || n.tag === 'tfoot') out.push(...rowsOf(n));
  }
  return out;
}

function table(el: RichElement, codes: string[], o: Ctx): string {
  const cellsOf = (tr: RichElement) =>
    tr.children
      .filter((n): n is RichElement => typeof n !== 'string' && (n.tag === 'td' || n.tag === 'th'))
      .map((c) => tidyInner(md(c.children, codes, o)));
  const raw = rowsOf(el)
    .map(cellsOf)
    .filter((cells) => cells.some((c) => c !== ''));
  if (raw.length === 0) return '';
  // A one-column "table" is layout, not data (most mail is built from them):
  // its cells are just blocks, their own structure (lists, paragraphs) kept.
  if (raw.every((cells) => cells.filter((c) => c !== '').length <= 1)) {
    return raw.map((cells) => cells.find((c) => c !== '') ?? '').join('\n\n');
  }
  // So is a one-row table (a row of buttons, a footer beside a logo): its cells read in line.
  if (raw.length === 1) return raw[0]!.filter((c) => c !== '').join(' ');
  const lines = raw.map((cells) => cells.map((c) => c.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')));
  const width = Math.max(...lines.map((cells) => cells.length));
  const row = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
  const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  return [row(lines[0]!), sep, ...lines.slice(1).map(row)].join('\n');
}

function md(nodes: readonly RichNode[], codes: string[], o: Ctx): string {
  const memo = (o.mdMemo ??= new WeakMap());
  const hit = memo.get(nodes);
  if (hit !== undefined) return hit;
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') {
      out += visible(decodeEntities(n)).replace(/[\s\u00a0]+/g, ' ');
      continue;
    }
    // Memoised in `md`: a hook and the default renderers all read it once.
    const inner = () => md(n.children, codes, o);
    if (o.element !== undefined && n.tag !== 'br') {
      const hooked = o.element(n, 'markdown', n.tag === 'img' ? '' : inner());
      if (hooked !== undefined) {
        out += hooked;
        continue;
      }
    }
    switch (n.tag) {
      case 'br':
        out += '\n';
        break;
      case 'p':
      case 'div':
        out += block(inner().trim());
        break;
      case 'hr':
        out += block('---');
        break;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const text = inner().replace(/\s+/g, ' ').trim();
        out += text === '' ? '' : block(`${'#'.repeat(Number(n.tag[1]))} ${text}`);
        break;
      }
      case 'b':
      case 'strong':
        out += wrap('**', inner());
        break;
      case 'i':
      case 'em':
        out += wrap('_', inner());
        break;
      case 's':
      case 'strike':
      case 'del':
        out += wrap('~~', inner());
        break;
      case 'code':
        out += inlineCode(codeText(n.children));
        break;
      case 'pre': {
        codes.push('```\n' + codeText(n.children).replace(/\n+$/, '') + '\n```');
        out += block(`${CODE_HOLE}${codes.length - 1}${CODE_HOLE}`);
        break;
      }
      case 'a': {
        // An image alone in a link reads as its alt text, not `[[alt]](…)`.
        const label = inner().trim().replace(/^\[([^\[\]]*)\]$/, '$1');
        const href = safeHref(n.attrs);
        if (href === undefined) out += label;
        else if (label === '' || label === href || LOOKS_LIKE_ADDRESS.test(label)) out += href;
        else out += `[${label}](${href.replace(/[()\s]/g, (c) => encodeURIComponent(c))})`;
        break;
      }
      case 'blockquote':
        out += block(
          tidyInner(inner())
            .split('\n')
            .map((l) => (l === '' ? '>' : `> ${l}`))
            .join('\n'),
        );
        break;
      case 'ul':
      case 'ol':
        out += block(list(n, codes, o));
        break;
      case 'table':
        out += block(table(n, codes, o));
        break;
      case 'img':
        out += defaultImageText(n);
        break;
      default:
        out += inner();
    }
  }
  memo.set(nodes, out);
  return out;
}

/**
 * A body as Markdown: bold, italic, strike, inline code, fenced code blocks,
 * numbered and bulleted lists (nested ones indented), links with their text,
 * quotes, headings, rules and tables (a one-column layout table reads as its
 * blocks). Typically far smaller than the HTML it came from.
 */
export function htmlToMarkdown(html: string, opts: HtmlReadOptions = {}): string {
  const codes: string[] = [];
  const lines = md(parseHtml(html, opts).children, codes, { ...opts }).split('\n');
  const tidy: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    // A line opening a block loses the space its source indentation left; list nesting is never there.
    tidy.push(tidy.length === 0 || tidy[tidy.length - 1] === '' ? line.trimStart() : line);
  }
  return tidy
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(new RegExp(`${CODE_HOLE}(\\d+)${CODE_HOLE}`, 'g'), (_w, i: string) => codes[Number(i)]!);
}
