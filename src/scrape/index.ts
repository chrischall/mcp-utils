/**
 * `scrape` — zero-dependency string/JSON extraction primitives for
 * server-rendered pages.
 *
 * Consolidates the SSR JSON-store extraction stack the fleet re-implemented at
 * least five times: musescore's `store.ts` (entity recovery + string-aware
 * bracket matching), tock's `redux-state.ts` (top-level slice extraction +
 * JS-literal repair) and `parse.ts` (cycle-guarded deep walkers), zillow's
 * `page-props.ts` (`findArrayByShape`), etix's `parse.ts` (JSON-LD / OpenGraph
 * / dataLayer readers), plus the entity-decode/strip-tags helpers duplicated in
 * alltrails / musescore / signupgenius and the anti-XSSI guard strippers in
 * workday / canvas / redfin.
 *
 * Everything here is pure string/JSON work — NO `node-html-parser`. DOM-level
 * scraping (tables, link lists) lives in `@chrischall/mcp-utils/html`, which
 * carries that optional peer dep; this module is safe for the core barrel.
 */

// ---------------------------------------------------------------------------
// Entity decoding / tag stripping
// ---------------------------------------------------------------------------

/** The named entities the fleet's scraped content actually contains. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decode HTML character references: decimal (`&#65;`) and hex (`&#x41;`)
 * numerics plus the common named entities. `&amp;` is decoded **last** so a
 * double-escaped entity survives exactly one level (`&amp;lt;` → `&lt;`, not
 * `<`) — the ordering both alltrails' `stripHtml` and musescore's `decodeText`
 * depend on when recovering attribute-escaped JSON. Unknown entities pass
 * through untouched.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (whole, d: string) => codePointOr(Number(d), whole))
    .replace(/&#x([0-9a-fA-F]+);/g, (whole, h: string) => codePointOr(parseInt(h, 16), whole))
    .replace(/&(nbsp|lt|gt|quot|apos);/gi, (whole, name: string) => {
      return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/&amp;/gi, '&');
}

/**
 * `String.fromCodePoint` for a scraped numeric entity, but SAFE: an out-of-range
 * code point (> 0x10FFFF, e.g. `&#999999999999;`) or a surrogate throws
 * `RangeError`, which on hostile input would crash the extractor. Return the raw
 * entity text unchanged instead, preserving the module's never-throw contract.
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
 * Strip an HTML **fragment** to readable text: tags → spaces, entities decoded
 * (via {@link decodeHtmlEntities}), whitespace collapsed and trimmed.
 *
 * For a full document where inline `<script>`/`<style>` *content* must not leak
 * into the output, use `extractPlainTextFromHtml` from
 * `@chrischall/mcp-utils/html` — this fragment-level helper does not remove
 * element content, only markup.
 */
export function stripHtml(html: string): string {
  if (!html) return '';
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Balanced-structure matching / marker extraction / JS-literal repair
// ---------------------------------------------------------------------------

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Replace bare JS `undefined` literals with `null` so a scraped JS object
 * literal becomes parseable JSON. String-aware: occurrences inside single- or
 * double-quoted strings are left alone, as are identifiers that merely contain
 * the word. Consolidates tock's `sanitizeJsLiterals`.
 */
export function sanitizeJsLiterals(text: string): string {
  let out = '';
  let inString: '"' | "'" | null = null;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ch;
      continue;
    }
    if (
      ch === 'u' &&
      text.startsWith('undefined', i) &&
      (i === 0 || !IDENT_CHAR.test(text[i - 1]!)) &&
      (i + 9 >= text.length || !IDENT_CHAR.test(text[i + 9]!))
    ) {
      out += 'null';
      i += 8;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Given `text[start]` on a `{` or `[`, walk the balanced structure — tracking
 * double- AND single-quoted strings and backslash escapes so brackets inside
 * string literals don't terminate it early — and return the **exclusive** end
 * index. Returns `-1` when `start` isn't on an opener or the structure never
 * closes. Consolidates musescore's `matchBracket` and the brace-walk inside
 * tock's `extractReduxSlice` (regex can't do this: the stores nest and escape).
 */
export function matchBalanced(text: string, start: number): number {
  const opener = text[start];
  if (opener !== '{' && opener !== '[') return -1;
  const stack: string[] = [];
  let inString: '"' | "'" | null = null;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Options for {@link extractJsonAfterMarker}. */
export interface ExtractJsonOptions {
  /** Run {@link sanitizeJsLiterals} before parsing (JS object literals). */
  sanitize?: boolean;
}

/**
 * Find the first of `markers` in `text`, skip to the next `{` or `[`, walk the
 * balanced structure ({@link matchBalanced}), and `JSON.parse` it. Returns
 * `null` on any failure — marker absent, no opener, unbalanced, or invalid
 * JSON — so callers can branch without a try/catch.
 *
 * The array-capable, multi-marker, JS-literal-tolerant generalization of the
 * `/html` subpath's `extractJsonFromHtml` (which is object-only and marker-form
 * fixed). Use this for `window.$REDUX_STATE` slices (tock), `__NEXT_DATA__`
 * analogues, and attribute-escaped stores (run the text through
 * {@link decodeHtmlEntities} first when the blob is entity-escaped).
 */
export function extractJsonAfterMarker(
  text: string,
  markers: string | string[],
  opts: ExtractJsonOptions = {},
): unknown {
  const list = Array.isArray(markers) ? markers : [markers];
  let idx = -1;
  let markerLen = 0;
  for (const m of list) {
    const i = text.indexOf(m);
    if (i >= 0) {
      idx = i;
      markerLen = m.length;
      break;
    }
  }
  if (idx < 0) return null;

  let start = idx + markerLen;
  while (start < text.length && text[start] !== '{' && text[start] !== '[') start++;
  if (start >= text.length) return null;

  const end = matchBalanced(text, start);
  if (end < 0) return null;

  let raw = text.slice(start, end);
  if (opts.sanitize) raw = sanitizeJsLiterals(raw);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON-LD / OpenGraph readers
// ---------------------------------------------------------------------------

const LD_JSON_ATTR_RE = /type\s*=\s*["']application\/ld\+json["']/i;

/**
 * Find the next opening tag `<name` in `html` at or after `from`, respecting a
 * tag-name boundary (so `<scriptish` doesn't match `<script`) and returning the
 * index of the `<`, or `-1`. `lowerHtml` is the pre-lowercased haystack; `name`
 * must be lowercase. Uses `indexOf` (linear) — the string primitives don't
 * backtrack, unlike a `/<name\b[^>]*>/g` regex which is O(n²) across many
 * openers when the closing `>` is withheld.
 */
function nextTagOpen(lowerHtml: string, name: string, from: number): number {
  const needle = `<${name}`;
  for (let i = lowerHtml.indexOf(needle, from); i >= 0; i = lowerHtml.indexOf(needle, i + 1)) {
    const after = lowerHtml[i + needle.length];
    // A real tag boundary: end, `>`, whitespace, or self-close/slash.
    if (after === undefined || after === '>' || after === '/' || after === ' ' || after === '\t' || after === '\n' || after === '\r' || after === '\f') {
      return i;
    }
  }
  return -1;
}

/**
 * Parse every `<script type="application/ld+json">` block in the page,
 * skipping malformed ones. Returns the parsed values in document order.
 * Consolidates etix's / tripadvisor's ld+json block iteration.
 *
 * Linear-time by construction: `indexOf`-driven tag scanning (find `<script`,
 * find its `>`, find `</script>`), never a `[^>]*>` regex — the previous
 * single mega-regex was O(n³) and its `[^>]*>`-per-opener replacement is still
 * O(n²); string `indexOf` doesn't backtrack, so an unterminated
 * `<script type="application/ld+json"` flood can't pin the event loop.
 */
export function extractJsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const lower = html.toLowerCase();
  let i = 0;
  for (;;) {
    const open = nextTagOpen(lower, 'script', i);
    if (open < 0) break;
    const tagEnd = html.indexOf('>', open);
    if (tagEnd < 0) break; // unterminated opening tag — nothing more to extract
    const attrs = html.slice(open + '<script'.length, tagEnd);
    const bodyStart = tagEnd + 1;
    const bodyEnd = lower.indexOf('</script>', bodyStart);
    if (bodyEnd < 0) break; // no closing tag
    i = bodyEnd + '</script>'.length;
    if (!LD_JSON_ATTR_RE.test(attrs)) continue;
    try {
      out.push(JSON.parse(html.slice(bodyStart, bodyEnd).trim()) as unknown);
    } catch {
      // Malformed block — skip, per every donor.
    }
  }
  return out;
}

/** True when a JSON-LD node's `@type` (string or array) includes `type`. */
function typeMatches(node: unknown, type: string): node is Record<string, unknown> {
  if (node === null || typeof node !== 'object') return false;
  const t = (node as Record<string, unknown>)['@type'];
  return t === type || (Array.isArray(t) && t.includes(type));
}

/**
 * Find the first schema.org entity of `@type === type` across the page's
 * JSON-LD blocks — checking each block itself, its array items, its `@graph`
 * items, and each candidate's `mainEntity` (the etix pattern: the Event often
 * hides inside a `WebPage.mainEntity`). Returns the matching node, or `null`.
 */
export function findJsonLdEntity(html: string, type: string): Record<string, unknown> | null {
  for (const block of extractJsonLdBlocks(html)) {
    const roots: unknown[] = Array.isArray(block) ? block : [block];
    for (const root of roots) {
      if (root === null || typeof root !== 'object') continue;
      const graph = (root as Record<string, unknown>)['@graph'];
      const candidates: unknown[] = [root, ...(Array.isArray(graph) ? graph : [])];
      for (const candidate of candidates) {
        if (typeMatches(candidate, type)) return candidate;
        const main = (candidate as Record<string, unknown> | null)?.['mainEntity'];
        if (typeMatches(main, type)) return main;
      }
    }
  }
  return null;
}

// These run only on a SINGLE bounded `<meta …>` tag's attribute text, so they
// carry no ReDoS risk (input is one tag, not the whole document).
const META_CONTENT_RE = /\bcontent\s*=\s*["']([^"']*)["']/i;
const META_PROP_RE = /\b(?:property|name)\s*=\s*["']([^"']*)["']/i;

/**
 * Read a `<meta property="og:…" content="…">` value, tolerant of either
 * attribute order (both occur in the wild — etix's `ogContent`) and of
 * `name=`-keyed OpenGraph. The content is entity-decoded. Returns `undefined`
 * when the property is absent.
 *
 * Linear-time by construction: `indexOf`-driven `<meta …>` scanning, reading
 * the `property`/`content` attributes WITHIN each single (bounded) tag — never
 * a `<meta\s[^>]*PROP[^>]*content…` regex, which backtracked quadratically on a
 * flood of unterminated `<meta property=…` (a ReDoS on hostile scraped HTML).
 */
export function ogContent(html: string, property: string): string | undefined {
  const want = property.toLowerCase();
  const lower = html.toLowerCase();
  let i = 0;
  for (;;) {
    const open = nextTagOpen(lower, 'meta', i);
    if (open < 0) return undefined;
    const tagEnd = html.indexOf('>', open);
    if (tagEnd < 0) return undefined; // unterminated tag — nothing more to read
    const attrs = html.slice(open + '<meta'.length, tagEnd);
    i = tagEnd + 1;
    const prop = META_PROP_RE.exec(attrs);
    if (!prop || prop[1]?.toLowerCase() !== want) continue;
    const content = META_CONTENT_RE.exec(attrs);
    if (content?.[1] !== undefined) return decodeHtmlEntities(content[1]);
  }
}

// ---------------------------------------------------------------------------
// Shape-directed JSON walking
// ---------------------------------------------------------------------------

/**
 * Locate an array inside a drifting JSON container (a `pageProps` /
 * `__NEXT_DATA__` blob): try `directKeys` first, then scan the container's
 * top-level array values and return the first whose FIRST element passes
 * `looksRight`. An empty array at a direct key is trusted (there is no first
 * element to test). Returns `[]` on a miss — never `undefined` — so projections
 * degrade to "no rows" instead of crashing when the upstream renames a key.
 * Consolidates zillow's `page-props.ts#findArrayByShape`.
 */
export function findArrayByShape<T = unknown>(
  container: Record<string, unknown>,
  directKeys: string[],
  looksRight: (first: unknown) => boolean,
): T[] {
  for (const key of directKeys) {
    const v = container[key];
    if (Array.isArray(v) && (v.length === 0 || looksRight(v[0]))) return v as T[];
  }
  for (const v of Object.values(container)) {
    if (Array.isArray(v) && v.length > 0 && looksRight(v[0])) return v as T[];
  }
  return [];
}

/**
 * Depth-first, cycle-guarded walk collecting every array whose FIRST element
 * passes `pred`. Recurses into matched arrays too (nested hits are collected).
 * Consolidates tock's `collectArrays` — the "walk for the shape, don't
 * hard-code the path" discipline for SSR stores.
 */
export function deepCollectArrays(root: unknown, pred: (first: unknown) => boolean): unknown[][] {
  const found: unknown[][] = [];
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length > 0 && pred(node[0])) found.push(node);
      for (const item of node) walk(item);
      return;
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(root);
  return found;
}

/**
 * Depth-first, cycle-guarded search for the first non-array object passing
 * `pred`. Returns `null` when nothing matches. Consolidates tock's
 * `findObject`.
 */
export function deepFindObject(
  root: unknown,
  pred: (obj: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): Record<string, unknown> | null => {
    if (node === null || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item);
        if (hit) return hit;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    if (pred(obj)) return obj;
    for (const v of Object.values(obj)) {
      const hit = walk(v);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

// ---------------------------------------------------------------------------
// Interstitial / guard detection
// ---------------------------------------------------------------------------

/**
 * Detect a Cloudflare challenge interstitial by its DEFINITIVE markers only:
 * the `_cf_chl_opt` bootstrap object or a `<title>Just a moment` page title.
 * Deliberately does NOT match `cdn-cgi/challenge-platform` or
 * `challenges.cloudflare.com` references — Cloudflare inlines those on CLEARED
 * pages too, and matching them false-positives on legit pages (the musescore
 * "search works but detail pages fail" bug). Consolidates the byte-identical
 * predicates in musescore and tock.
 */
export function isCloudflareChallenge(html: string): boolean {
  return /_cf_chl_opt/.test(html) || /<title[^>]*>\s*Just a moment/i.test(html);
}

// Known anti-XSSI guard prefixes, each anchored to the string start:
// Google-style `)]}'`, Facebook-style `for(;;);`, the classic `while(1);`,
// and redfin's stingray `{}&&`.
const GUARD_RES = [/^\)\]\}'/, /^while\s*\(\s*1\s*\)\s*;?/, /^for\s*\(\s*;;\s*\)\s*;?/, /^\{\}&&/];

/**
 * Strip anti-XSSI / anti-JSON-hijacking guard prefixes from a response body so
 * it parses as JSON: `)]}'`, `while(1);`, `for(;;);`, and `{}&&` (redfin's
 * stingray envelope), plus surrounding whitespace, applied repeatedly until no
 * guard remains. Unguarded input passes through unchanged. Consolidates
 * workday's `stripJsonGuard`, canvas-parent's `while(1);` strip, and redfin's
 * `stripStingrayPrefix`.
 */
export function stripJsonGuard(text: string): string {
  let out = text.trimStart();
  for (;;) {
    const before = out;
    for (const re of GUARD_RES) {
      out = out.replace(re, '').trimStart();
    }
    if (out === before) return out;
  }
}
