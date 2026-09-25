/**
 * Source check: every call to mcp-utils' path-taking file helpers passes
 * `allowedRoots` (fleet audit 2026-09-24 REF-1, fleet-audit#945).
 *
 * `fileBlob`, `readFileHead` and `resolveOutputDir` take paths straight from
 * tool arguments. Without `allowedRoots` a prompt-injected path (`~/.ssh/…`,
 * the session store, `/proc/self/environ`) is read and uploaded, or an output
 * directory is created wherever the model says. The helpers have confined
 * opt-in since 2.3 (see src/fs/confine.ts); this makes the opt-in visible.
 *
 * Unlike the confirm-gate checks, this cannot be read off the wire — a
 * served inputSchema says `path: string` either way — so it reads source.
 * It is deliberately a TEXT check, zero-dependency so the fleet CI can run it
 * from a bare clone of this repo:
 *
 * - Only names IMPORTED from `@chrischall/mcp-utils` (the barrel or any
 *   subpath) count, following `as` aliases and `* as ns` namespaces. A
 *   repo-local function that happens to be called `resolveOutputDir`
 *   (gemini-mcp, flightaware-mcp) is not this helper and is not checked.
 * - A call passes when the token `allowedRoots` appears in its own argument
 *   list, outside comments and strings: a key, a shorthand `{ allowedRoots }`,
 *   or a conditional spread all count. Options built in a separate variable
 *   do not — inline them, so a reviewer sees the confinement at the call.
 * - `resolveOutputDir(undefined, …)` is exempt: with no per-call directory it
 *   reads only the operator's env var, which `allowedRoots` never constrains.
 *
 * It checks that confinement is PASSED, not what the roots are: a roots value
 * that is `undefined` at run time (an optional `<SVC>_UPLOAD_DIR` left unset)
 * still passes. That decision is the repo's, and now it is written down at the
 * call site.
 *
 * The scanner masks comments, strings, template text and regex literals
 * before matching, so neither `// fileBlob(x)` nor `')'` inside an argument
 * confuses it. A regex literal is recognised by the usual previous-token
 * heuristic, which is enough for the fleet's code.
 */

/** The mcp-utils exports this lint checks. */
export const FS_HELPERS = Object.freeze(['fileBlob', 'readFileHead', 'resolveOutputDir']);

const MODULE = /^@chrischall\/mcp-utils(?:\/.*)?$/;
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;
/** Keywords after which a `/` starts a regex literal rather than dividing. */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

/**
 * Blank out comments and the contents of strings, template text and regex
 * literals (newlines kept, so offsets and line numbers still match), and
 * collect every string literal with its decoded-enough value.
 *
 * @param {string} src
 * @returns {{ code: string, strings: Map<number, string> }} strings keyed by
 *   the offset of the opening quote.
 */
function mask(src) {
  const out = src.split('');
  const strings = new Map();
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Template nesting: each entry is the brace depth at which a `${` opened.
  const templates = [];
  let braces = 0;
  let prev = ''; // last significant code char, or 'w:<word>' for a word
  let i = 0;
  const n = src.length;

  const scanTemplateText = (start) => {
    // start is just after a backtick or a closing `}` of `${…}`.
    let j = start;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { blank(start, j); return { end: j + 1, open: false }; }
      if (c === '$' && src[j + 1] === '{') { blank(start, j); return { end: j + 2, open: true }; }
      j++;
    }
    blank(start, n);
    return { end: n, open: false };
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') { value += src[j + 1] ?? ''; j += 2; continue; }
        value += src[j];
        j++;
      }
      strings.set(i, value);
      blank(i + 1, Math.min(j, n));
      i = j + 1;
      prev = 'str';
      continue;
    }
    if (c === '`') {
      const r = scanTemplateText(i + 1);
      if (r.open) templates.push(braces);
      i = r.end;
      prev = r.open ? '{' : 'str';
      if (r.open) braces++;
      continue;
    }
    if (c === '/') {
      const regexAllowed =
        prev === '' ||
        (prev.startsWith('w:') ? REGEX_AFTER_WORD.has(prev.slice(2)) : !/^[)\]}]$|^str$|^num$/.test(prev));
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== '\n') {
          const r = src[j];
          if (r === '\\') { j += 2; continue; }
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) break;
          j++;
        }
        blank(i + 1, j);
        i = j + 1;
        while (i < n && IDENT_PART.test(src[i])) i++; // flags
        prev = 'str';
        continue;
      }
    }
    if (c === '{') { braces++; prev = '{'; i++; continue; }
    if (c === '}') {
      braces--;
      if (templates.length > 0 && templates[templates.length - 1] === braces) {
        templates.pop();
        const r = scanTemplateText(i + 1);
        if (r.open) { templates.push(braces); braces++; }
        i = r.end;
        prev = r.open ? '{' : 'str';
        continue;
      }
      prev = '}';
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(src[j])) j++;
      prev = `w:${src.slice(i, j)}`;
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      prev = 'num';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code: out.join(''), strings };
}

/**
 * Local bindings for the helpers, from `import … from '@chrischall/mcp-utils…'`.
 *
 * @returns {{ named: Map<string, string>, namespaces: Set<string> }} named maps
 *   local name → helper name.
 */
function helperBindings(code, strings) {
  const named = new Map();
  const namespaces = new Set();
  const importRe = /\bimport\s+(?!type\s*[{*]|type\s+[\w$]+\s*(?:,|\bfrom\b))([^;]*?)\s*\bfrom\s*(?=["'])/g;
  for (const m of code.matchAll(importRe)) {
    const quoteAt = m.index + m[0].length;
    const spec = strings.get(quoteAt);
    if (spec === undefined || !MODULE.test(spec)) continue;
    const clause = m[1];
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns) namespaces.add(ns[1]);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (!braces) continue;
    for (const part of braces[1].split(',')) {
      const p = part.trim();
      if (!p || /^type\s/.test(p)) continue;
      const as = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(p);
      if (!as) continue;
      const [, imported, local] = as;
      if (FS_HELPERS.includes(imported)) named.set(local ?? imported, imported);
    }
  }
  return { named, namespaces };
}

/** Index of the `)` matching the `(` at `open`, on masked code; -1 if none. */
function closingParen(code, open) {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    const c = code[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return c === ')' ? k : -1;
    }
  }
  return -1;
}

/** The first top-level argument of an argument list (masked, no parens). */
function firstArgument(args) {
  let depth = 0;
  for (let k = 0; k < args.length; k++) {
    const c = args[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return args.slice(0, k);
  }
  return args;
}

/**
 * @typedef {{ helper: string, local: string, line: number, column: number, text: string }} UnconfinedCall
 * @typedef {UnconfinedCall & { confined: boolean }} FsHelperCall
 */

/**
 * Every call to an mcp-utils file helper in `source`, each marked `confined`
 * when it passes `allowedRoots` (or is the exempt `resolveOutputDir(undefined,
 * …)`). Line and column are 1-based and point at the callee (the namespace,
 * for `ns.fileBlob(…)`).
 *
 * @param {string} source
 * @returns {FsHelperCall[]}
 */
export function findFsHelperCalls(source) {
  const { code, strings } = mask(source);
  const { named, namespaces } = helperBindings(code, strings);
  if (named.size === 0 && namespaces.size === 0) return [];

  const esc = (s) => s.replace(/[$]/g, '\\$');
  const alts = [];
  for (const local of named.keys()) alts.push(esc(local));
  for (const ns of namespaces) alts.push(`${esc(ns)}\\s*\\??\\.\\s*(?:${FS_HELPERS.join('|')})`);
  const callRe = new RegExp(`(?<![\\w$.])(${alts.join('|')})\\s*(?:\\?\\.\\s*)?\\(`, 'g');

  const lineStarts = [0];
  for (let k = 0; k < source.length; k++) if (source[k] === '\n') lineStarts.push(k + 1);
  const position = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
  };

  const findings = [];
  for (const m of code.matchAll(callRe)) {
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/\bfunction\s*\*?\s*$/.test(before)) continue; // a declaration, not a call
    const callee = m[1];
    const helper = named.get(callee) ?? callee.replace(/^.*\.\s*/, '');
    const open = m.index + m[0].length - 1;
    const close = closingParen(code, open);
    if (close === -1) continue;
    const args = code.slice(open + 1, close);
    const confined =
      /(?<![\w$])allowedRoots(?![\w$])/.test(args) ||
      (helper === 'resolveOutputDir' && firstArgument(args).trim() === 'undefined');
    findings.push({
      confined,
      helper,
      local: callee.replace(/\s+/g, ''),
      ...position(m.index),
      text: source.slice(m.index, close + 1).replace(/\s+/g, ' ').trim(),
    });
  }
  return findings;
}

/**
 * The calls in `source` that fail the rule: an mcp-utils file helper called
 * without `allowedRoots`. See {@link findFsHelperCalls}.
 *
 * @param {string} source
 * @returns {UnconfinedCall[]}
 */
export function findUnconfinedFsCalls(source) {
  return findFsHelperCalls(source)
    .filter((c) => !c.confined)
    .map(({ confined: _confined, ...call }) => call);
}

const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__']);

/**
 * Whether a repo-relative path is server source this lint reads: JS/TS, not a
 * declaration file, not a test (`*.test.*`, `*.spec.*`, or under `test/`,
 * `tests/`, `__tests__/`, `__mocks__/`). Tests call the helpers on temp paths
 * on purpose and never run in a served tool.
 */
export function isLintedSourceFile(relPath) {
  const parts = relPath.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? '';
  if (!SOURCE_EXT.test(base) || base.endsWith('.d.ts') || TEST_FILE.test(base)) return false;
  return !parts.slice(0, -1).some((p) => TEST_DIRS.has(p));
}

/** Directories never descended into: dependencies, build output, VCS. */
export const SKIPPED_DIRS = Object.freeze(new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.wrangler', '.next', '.turbo',
]));
