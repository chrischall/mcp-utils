/**
 * Opt-in HTML helpers for the chrischall MCP fleet.
 *
 * Isolated behind the `@chrischall/mcp-utils/html` subpath because it pulls the
 * heavy `node-html-parser` dependency — lean API-only MCPs shouldn't pay for it.
 *
 * Consolidates the HTML-scraping primitives that were independently
 * re-implemented across the realty cohort (homes / redfin / compass /
 * zillow / onehome) and a couple of content MCPs (opentable, infinitecampus):
 *
 *   - `parsePropertyTable` / `findLinksUnderHeading` — heading-anchored DOM
 *     scraping for the SSR property-detail tables and link lists.
 *   - `extractJsonFromHtml` — the balanced-brace `__INITIAL_STATE__` walker
 *     (opentable / compass / realty); regex can't handle nested objects and
 *     escaped strings.
 *   - `extractPlainTextFromHtml` — dependency-free script/style strip + entity
 *     decode used to render Infinite Campus message bodies as plain text.
 *   - `htmlToReadableText` — the block-aware DOM text extractor (onthecheap):
 *     block boundaries become word breaks, inline markup stays joined, code
 *     elements are dropped, every entity is decoded.
 *   - `urlToPath` / `locationToSlug` / `buildIdExtractor` — the small URL atoms
 *     that were byte-identical across the cohort.
 */

import { parse, NodeType, type HTMLElement, type Node, type TextNode } from 'node-html-parser';
import { asciiLower } from '../internal/ascii.js';
import { replaceTags } from '../internal/tags.js';
import { decodeHtmlEntities } from '../scrape/index.js';

export type { HTMLElement };

/** A scraped HTML table: column headers plus row-major cell text. */
export interface PropertyTable {
  /** Trimmed text of each header cell, in document order. */
  headers: string[];
  /** Each body row as an array of trimmed cell strings, in document order. */
  rows: string[][];
}

/** Normalise an element's text: collapse internal whitespace runs and trim. */
function cellText(el: HTMLElement): string {
  return el.text.replace(/\s+/g, ' ').trim();
}

/** Coerce a raw HTML string or an already-parsed root into an `HTMLElement`. */
function toRoot(input: string | HTMLElement): HTMLElement {
  return typeof input === 'string' ? boundedParse(input, { lowerCaseTagName: false, comment: false }) : input;
}

/**
 * Past this many never-closed elements, {@link boundedParse} repairs the markup
 * itself before parsing (see there). Real pages leave a handful open; at 500
 * node-html-parser's own repair still finishes in ~25 ms on the worst
 * interleaving measured.
 */
export const HTML_UNCLOSED_REPAIR_MAX = 500;

/**
 * Void elements and elements whose end tag the parser implies (`<p>`, `<li>`,
 * `<td>`, …) — neither is left open at end of input, so neither is tracked.
 */
const NEVER_LEFT_OPEN = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr', 'li', 'p', 'dt', 'dd', 'td', 'th', 'tr', 'option', 'optgroup', 'thead', 'tbody',
  'tfoot', 'colgroup', 'caption', 'rt', 'rp', 'html', 'head', 'body',
]);

/** Raw-text elements node-html-parser skips to their close tag. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'pre']);

const TAG_NAME_CHAR = /[a-z0-9:_.-]/;

/**
 * Find the opening tags a parse would leave unclosed, in one linear scan that
 * mirrors node-html-parser's nesting: an opener is pushed, a closer pops the
 * innermost element only when the names match (the parser ignores a closer
 * that does not match its current element), comments and raw-text element
 * bodies are skipped. Returns the `[start, end)` source span of each opener
 * still on the stack at end of input.
 */
function findUnclosedOpeners(html: string): Array<[number, number]> {
  const lower = asciiLower(html);
  const stack: Array<{ name: string; span: [number, number] }> = [];
  let i = 0;
  for (;;) {
    const lt = lower.indexOf('<', i);
    if (lt < 0) break;
    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const closing = lower[lt + 1] === '/';
    let p = lt + (closing ? 2 : 1);
    const nameStart = p;
    while (p < lower.length && TAG_NAME_CHAR.test(lower[p]!)) p++;
    const first = lower[nameStart];
    if (p === nameStart || first === undefined || first < 'a' || first > 'z') {
      i = lt + 1;
      continue;
    }
    const name = lower.slice(nameStart, p);
    const gt = lower.indexOf('>', p);
    if (gt < 0) break;
    i = gt + 1;
    if (closing) {
      if (stack.length > 0 && stack[stack.length - 1]!.name === name) stack.pop();
      continue;
    }
    if (lower[gt - 1] === '/' || NEVER_LEFT_OPEN.has(name)) continue;
    if (RAW_TEXT_TAGS.has(name)) {
      const end = lower.indexOf(`</${name}>`, i);
      if (end < 0) break;
      i = end + name.length + 3;
      continue;
    }
    stack.push({ name, span: [lt, gt + 1] });
  }
  return stack.map((e) => e.span);
}

/**
 * `parse()` with a bound on node-html-parser's unclosed-tag repair, which is
 * superlinear: 8000 unclosed `<div>` (39 KB) took 23 s, so one hostile or
 * MITM'd response could pin the process (fleet-audit#1197). The parser's
 * repair removes each never-closed element and hands its children to the
 * parent — the same tree as deleting the never-closed opening tag from the
 * source. So when the input would leave more than
 * {@link HTML_UNCLOSED_REPAIR_MAX} elements open, those opening tags are cut
 * from the source in one linear pass first, and the parse that follows has
 * (almost) nothing left to repair. Well-formed pages take the untouched path.
 */
function boundedParse(html: string, options: Parameters<typeof parse>[1] = {}): HTMLElement {
  const unclosed = findUnclosedOpeners(html);
  if (unclosed.length <= HTML_UNCLOSED_REPAIR_MAX) return parse(html, options);
  let repaired = '';
  let at = 0;
  for (const [start, end] of unclosed) {
    repaired += html.slice(at, start);
    at = end;
  }
  return parse(repaired + html.slice(at), options);
}

/**
 * Find the first `<h1>`–`<h4>` whose text contains `heading` (case-insensitive,
 * substring), then return the nearest following `<table>`.
 *
 * Walks forward through the heading's siblings, stopping at the next heading.
 * If nothing's found and the heading lives in a dedicated wrapper
 * (`<section>`/`<article>`/`<aside>`), it looks inside that wrapper (but not the
 * broader parent — peer headings might own peer tables).
 */
function findTableByHeading(root: HTMLElement, heading: string): HTMLElement | null {
  const needle = heading.trim().toLowerCase();
  for (const h of root.querySelectorAll('h1, h2, h3, h4')) {
    if (!h.text.toLowerCase().includes(needle)) continue;
    let cur: HTMLElement | null = h.nextElementSibling as HTMLElement | null;
    while (cur) {
      if (/^H[1-4]$/.test(cur.tagName)) break;
      if (cur.tagName === 'TABLE') return cur;
      const nested = cur.querySelector('table');
      if (nested) return nested;
      cur = cur.nextElementSibling as HTMLElement | null;
    }
    const parent = h.parentNode as HTMLElement | null;
    if (parent && /^(SECTION|ARTICLE|ASIDE)$/.test(parent.tagName)) {
      const inside = parent.querySelector('table');
      if (inside) return inside;
    }
  }
  return null;
}

/**
 * Locate the `<table>` under the heading matching `heading` and return its
 * column headers and body rows.
 *
 * Header cells are scoped to `<thead>` when present (falling back to all `<th>`
 * in the table). Body rows collect **both** `<th>` and `<td>` because the realty
 * portals use `<th scope="row">` for the leading cell of every data row (the
 * year / date column) — dropping those would silently shift every column left
 * and corrupt the parsed record.
 *
 * Cell text has internal whitespace collapsed to single spaces and is trimmed.
 *
 * @param html    Raw page HTML (or an HTML fragment).
 * @param heading Case-insensitive substring of the heading above the table.
 * @returns The parsed table, or `null` when no matching heading+table is found.
 *
 * @example parsePropertyTable(detailHtml, 'Tax History')
 *   // { headers: ['Year', 'Property Tax'], rows: [['2023', '$1,200'], ...] }
 */
export function parsePropertyTable(
  html: string | HTMLElement,
  heading: string,
): PropertyTable | null {
  const table = findTableByHeading(toRoot(html), heading);
  if (!table) return null;

  const thead = table.querySelector('thead');
  const headerScope = thead ?? table;
  const headers = headerScope.querySelectorAll('th').map(cellText);

  const tbody = table.querySelector('tbody') ?? table;
  const rows = tbody
    .querySelectorAll('tr')
    .map((tr) => tr.querySelectorAll('th, td').map(cellText))
    .filter((cells) => cells.length > 0);

  return { headers, rows };
}

/**
 * Find every `<a>` (or `selector`-matching element) that follows the first
 * heading matching `heading`, up to — but not including — the next sibling
 * heading. Useful for the "Homes for Sale Near" link lists at the bottom of a
 * detail page.
 *
 * Collects both direct-sibling anchors and anchors nested inside the
 * intervening sibling elements (lists, cards), in document order.
 *
 * @param root     Raw HTML string or an already-parsed root element.
 * @param heading  Case-insensitive substring of the heading to anchor on.
 * @param selector CSS selector for the elements to collect (default `'a'`).
 * @returns The matching elements, or an empty array when the heading is absent.
 */
export function findLinksUnderHeading(
  root: string | HTMLElement,
  heading: string,
  selector = 'a',
): HTMLElement[] {
  const parsed = toRoot(root);
  const needle = heading.trim().toLowerCase();
  for (const h of parsed.querySelectorAll('h1, h2, h3, h4')) {
    if (!h.text.toLowerCase().includes(needle)) continue;
    const out: HTMLElement[] = [];
    let cur: HTMLElement | null = h.nextElementSibling as HTMLElement | null;
    while (cur) {
      if (/^H[1-4]$/.test(cur.tagName)) break;
      if (cur.matches?.(selector)) out.push(cur);
      for (const el of cur.querySelectorAll(selector)) out.push(el);
      cur = cur.nextElementSibling as HTMLElement | null;
    }
    return out;
  }
  return [];
}

/**
 * Extract an embedded JSON state object from a server-rendered HTML page by
 * walking the balanced brace/string structure after a marker.
 *
 * Handles both rendering forms seen across the fleet:
 *   1. `window.__INITIAL_STATE__ = {...};` — a JS assignment in a `<script>`.
 *   2. `"__INITIAL_STATE__":{...}` — a JSON key inside a larger embedded blob.
 *
 * A regex can't be used: the state contains nested objects and escaped strings.
 * This walks the structure tracking string/escape context so braces inside
 * string literals don't terminate the object early.
 *
 * Unlike the per-MCP `extractInitialState`, this returns `null` (rather than
 * throwing) on any failure — no marker, unbalanced braces, or invalid JSON —
 * so callers can branch on a missing blob without a try/catch.
 *
 * @param html   The page HTML.
 * @param marker The state key to search for (default `'__INITIAL_STATE__'`).
 *               Both the `window.<marker>` and `"<marker>"` forms are tried.
 * @returns The parsed object, or `null` if not found / not parseable.
 */
export function extractJsonFromHtml(
  html: string,
  marker = '__INITIAL_STATE__',
): Record<string, unknown> | null {
  const candidates = [`window.${marker}`, `"${marker}"`];
  let idx = -1;
  let markerLen = 0;
  for (const m of candidates) {
    const i = html.indexOf(m);
    if (i >= 0) {
      idx = i;
      markerLen = m.length;
      break;
    }
  }
  if (idx < 0) return null;

  let start = idx + markerLen;
  while (start < html.length && html[start] !== '{') start++;
  if (start >= html.length) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;

  try {
    return JSON.parse(html.slice(start, end)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Strip an HTML document down to its readable plain text: remove `<script>` and
 * `<style>` blocks (and their contents), drop all remaining tags, decode common
 * HTML entities (via `decodeHtmlEntities` from the `scrape` module, so the two
 * renderers share one table), then collapse whitespace. Linear in the input.
 *
 * Dependency-free (no DOM parser) — this mirrors the Infinite Campus message
 * extractor, which renders `messageView.xsl` bodies into a flat string. Removing
 * `<script>`/`<style>` *content* first is load-bearing for safety: it ensures
 * inline JS/CSS text never leaks into the surfaced message body.
 *
 * @param html The HTML (full document or fragment).
 * @returns The decoded, whitespace-collapsed plain text (`''` for empty input).
 */
export function extractPlainTextFromHtml(html: string): string {
  if (!html) return '';
  // Strip <script>/<style> element CONTENT via a LINEAR indexOf scan. The former
  // `/<script[\s\S]*?<\/script>/gi` lazy regexes backtracked quadratically on a
  // flood of unterminated `<script` tags (a ReDoS on untrusted message bodies);
  // a single forward pass is O(n) and preserves the load-bearing safety property
  // (inline JS/CSS text never reaches the output).
  let text = stripElementContent(stripElementContent(html, 'script'), 'style');
  // Drop all remaining tags — a linear scan with `/<[^>]+>/g` semantics (the
  // regex itself was quadratic on a withheld `>`, fleet-audit#1197) — then
  // decode through scrape's decodeHtmlEntities, the one entity table
  // (fleet-audit#1300): numeric references guarded against out-of-range code
  // points, the common named entities, and `&amp;` last so a double-escaped
  // entity survives exactly one level.
  text = decodeHtmlEntities(replaceTags(text, ' '));
  // Collapse whitespace runs and trim.
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Remove every `<tag …>…</tag>` element (opening tag, content, and close) in a
 * single linear forward pass. An unterminated opener drops the remainder — the
 * safe choice for the script/style strip (never leak the tail). Case-insensitive
 * on the tag name.
 */
function stripElementContent(html: string, tag: string): string {
  const lower = asciiLower(html);
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let out = '';
  let i = 0;
  for (;;) {
    const start = lower.indexOf(open, i);
    if (start < 0) {
      out += html.slice(i);
      return out;
    }
    // Require a tag-name boundary (`<script>` / `<script ` / `<script\n`), so
    // `<scriptish>` isn't treated as a <script>. The whitespace set matches the
    // scrape module's `nextTagOpen` (HTML5 ASCII whitespace incl. `\f`).
    const after = lower[start + open.length];
    if (after !== undefined && after !== '>' && after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r' && after !== '\f' && after !== '/') {
      out += html.slice(i, start + open.length);
      i = start + open.length;
      continue;
    }
    out += html.slice(i, start) + ' ';
    const closeAt = lower.indexOf(close, start + open.length);
    if (closeAt < 0) return out; // unterminated: drop the rest
    i = closeAt + close.length;
  }
}


// ---------------------------------------------------------------------------
// htmlToReadableText
// ---------------------------------------------------------------------------

/** Elements whose content is code or data, never readable text. */
const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG']);

/**
 * Elements that start a new line when rendered. Their boundaries become a word
 * break; inline elements (`<b>`, `<a>`, …) do not, so `<b>F</b>ree` stays one
 * word.
 */
const BREAK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TD', 'TH',
  'TR', 'UL',
]);

/** Options for {@link htmlToReadableText}. */
export interface ReadableTextOptions {
  /**
   * Cap the result at this many characters (plus a trailing `…`). The cut
   * lands on the last word boundary when that keeps at least 60% of the
   * budget, otherwise mid-word. Omit for no cap.
   */
  limit?: number;
}

/**
 * Render HTML as readable plain text, the way a browser would lay the words
 * out: markup stripped, every HTML entity decoded, whitespace collapsed.
 *
 * Unlike {@link extractPlainTextFromHtml} (the dependency-free regex version,
 * kept unchanged for its callers) this walks the DOM, so:
 *   - **block** boundaries (`<p>`, `<div>`, `<li>`, `<td>`, `<br>`, headings, …)
 *     become word breaks — `<p>One</p><p>Two</p>` → `One Two`, not `OneTwo`;
 *   - **inline** markup stays joined — `<b>F</b>ree` → `Free`, not `F ree`;
 *   - `<script>`/`<style>` (incl. JSON-LD), `<noscript>`, `<template>`,
 *     `<iframe>` and `<svg>` content is dropped, and comments are ignored;
 *   - the full named-entity table is decoded (`&eacute;`, `&ndash;`, …).
 *
 * Use it for article / post / message bodies. The walk is iterative, so
 * hostile nesting depth cannot overflow the stack; and the parse is bounded
 * (past {@link HTML_UNCLOSED_REPAIR_MAX} unclosed elements the parser's
 * superlinear repair is skipped), so a flood of unclosed tags cannot pin the
 * process either. There is no size cap: a 2 MB well-formed page parses in
 * well under 100 ms. Hoisted from onthecheap-mcp's `htmlToText` (fleet audit
 * #1083).
 *
 * @param html The HTML (fragment or full document). `null`/`undefined` → `''`.
 * @returns The readable text (`''` for empty input).
 */
export function htmlToReadableText(html: string | null | undefined, opts: ReadableTextOptions = {}): string {
  if (!html) return '';
  const parts: string[] = [];
  // Explicit stack instead of recursion; a `string` entry is a pending break
  // to emit after an element's children.
  // node-html-parser surfaces a leading `<!doctype …>` as a TEXT node, so it
  // would read as words; drop it before parsing (anchored, so linear).
  const stack: Array<Node | string> = [boundedParse(html.replace(/^\s*<!doctype[^>]*>/i, ''))];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (item.nodeType === NodeType.TEXT_NODE) {
      parts.push((item as TextNode).text); // `.text` is entity-decoded
      continue;
    }
    if (item.nodeType !== NodeType.ELEMENT_NODE) continue; // comments
    const tag = (item as HTMLElement).tagName ?? '';
    if (NON_TEXT_TAGS.has(tag)) continue;
    const breaks = BREAK_TAGS.has(tag);
    if (breaks) {
      parts.push(' ');
      stack.push(' ');
    }
    const children = item.childNodes;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  const { limit } = opts;
  if (limit === undefined || text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * Reduce a portal URL (or path) to its `pathname + search` portion.
 *
 * Accepts an absolute URL (any host — only the path is kept), a path already
 * starting with `/` (returned unchanged), or a bare segment which is coerced to
 * a leading-slash path. Malformed input that `new URL()` can't parse falls
 * through to the same coercion branch, so the function never throws.
 *
 * @example urlToPath('https://www.zillow.com/homedetails/foo/7_zpid/')
 *   // '/homedetails/foo/7_zpid/'
 * @example urlToPath('homedetails/7_zpid/')  // '/homedetails/7_zpid/'
 * @example urlToPath('/already/a/path/')     // '/already/a/path/'
 */
export function urlToPath(input: string): string {
  try {
    const u = new URL(input);
    return `${u.pathname}${u.search}`;
  } catch {
    return input.startsWith('/') ? input : `/${input}`;
  }
}

/**
 * Slugify a free-text location into a portal search-URL segment.
 *
 * NFKD-normalises, strips diacritics, lowercases, collapses runs of
 * non-alphanumerics to a single `-`, then trims leading/trailing `-`. A bare ZIP
 * passes through unchanged.
 *
 * @example locationToSlug('Brooklyn, NY')  // 'brooklyn-ny'
 * @example locationToSlug('Cañon City, CO') // 'canon-city-co'
 * @example locationToSlug('94110')         // '94110'
 */
export function locationToSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build a stateless id-extractor from a regular expression.
 *
 * Returns a function that runs `regex` against a URL/path and yields the first
 * capture group (or the whole match when the pattern has no groups), or
 * `undefined` on no match / nullish input.
 *
 * The extractor is **stateless**: a fresh `RegExp` is constructed per call so a
 * `g`/`y`-flagged source can't carry `lastIndex` between invocations and
 * silently skip matches.
 *
 * @example buildIdExtractor(/\/home\/(\d+)(?:[/?#]|$)/)('/x/home/42/') // '42'
 * @example buildIdExtractor(/\/([A-Za-z0-9]+)_pid\/?$/)('/s/abc_pid/') // 'abc'
 */
export function buildIdExtractor(
  regex: RegExp,
): (input: string | undefined | null) => string | undefined {
  // Strip stateful flags so each call is independent of prior matches.
  const flags = regex.flags.replace(/[gy]/g, '');
  const source = regex.source;
  return (input) => {
    if (!input) return undefined;
    const m = new RegExp(source, flags).exec(input);
    if (!m) return undefined;
    return m[1] ?? m[0];
  };
}
