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
 *   - `urlToPath` / `locationToSlug` / `buildIdExtractor` — the small URL atoms
 *     that were byte-identical across the cohort.
 */

import { parse, type HTMLElement } from 'node-html-parser';

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
  return typeof input === 'string'
    ? parse(input, { lowerCaseTagName: false, comment: false })
    : input;
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

/** The small set of named entities IC message bodies actually contain. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Strip an HTML document down to its readable plain text: remove `<script>` and
 * `<style>` blocks (and their contents), drop all remaining tags, decode common
 * HTML entities, then collapse whitespace.
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
  // Drop all remaining tags.
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode numeric (decimal + hex) references, guarding out-of-range code points
  // (`&#999999999999;`) that would otherwise throw RangeError on hostile input.
  text = text.replace(/&#(\d+);/g, (whole, d: string) => codePointOr(Number(d), whole));
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (whole, h: string) => codePointOr(parseInt(h, 16), whole));
  // Decode the common named entities.
  text = text.replace(/&([a-zA-Z]+);/g, (whole, name: string) => {
    const decoded = NAMED_ENTITIES[name.toLowerCase()];
    return decoded ?? whole;
  });
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
  const lower = html.toLowerCase();
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

/**
 * `String.fromCodePoint` guarded against a `RangeError` on an out-of-range
 * (negative or > 0x10FFFF) code point from a scraped numeric entity — returns
 * the raw entity text unchanged instead of throwing. (Lone surrogates do NOT
 * throw and pass the guard, yielding a lone-surrogate string; harmless here.)
 */
function codePointOr(code: number, raw: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return raw;
  try {
    return String.fromCodePoint(code);
  } catch {
    return raw;
  }
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
