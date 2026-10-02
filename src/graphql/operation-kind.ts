/**
 * GraphQL operation-kind detection — "is this document a query, a mutation or
 * a subscription?" — without a `graphql` dependency.
 *
 * Consolidates three independent answers to the same question
 * (chrischall/fleet-audit#1080, #988, #1020), plus vibo's fourth:
 *
 *  - onehome-mcp `src/tools/graphql.ts` `topLevelOperationKinds` — regex-blanks
 *    strings and comments, then reads the first word of each depth-0
 *    definition. Gates the read-only `onehome_graphql` passthrough tool.
 *  - hemnet-mcp `src/transport-fetchproxy.ts` `isReadOnlyOperation` — a char
 *    lexer (BOM, commas, `\"""` escapes) that collects EVERY depth-0 name, so a
 *    query merely NAMED `mutation` (or carrying an `@mutation` directive) is
 *    misread as a write. Gates the bridge's retry-on-timeout.
 *  - booli-mcp `src/transport-fetchproxy.ts` `isMutation` — `/\bmutation\b/`,
 *    which refuses the timeout retry for any query with a field, alias,
 *    argument or comment containing the word.
 *  - vibo-mcp `src/client.ts` `isMutation` — `^\s*(#…)*mutation\b`, which
 *    misses a mutation preceded by a fragment or a query, so a timed-out
 *    write was reported as a safe-to-retry read.
 *
 * This one is a real tokenizer feeding a tiny top-level grammar: strings,
 * block strings (with the spec's `\"""` escape) and comments are consumed as
 * tokens, so their contents can never look like keywords; only the keyword
 * that STARTS each top-level definition is read, so names, directives and
 * variables never count. It is a single linear pass (no regex backtracking),
 * which matters because it runs on caller-supplied documents.
 */

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'string' };

interface Lexed {
  tokens: Token[];
  /** An unterminated string or block string was hit. */
  unterminated: boolean;
}

const NAME_START = /[_A-Za-z]/;
const NAME_CONTINUE = /[_0-9A-Za-z]/;

/** Tokenize per the GraphQL lexical grammar, keeping only what the top level needs. */
function lex(src: string): Lexed {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    // Ignored tokens: BOM, whitespace, line terminators, commas.
    if (c === '﻿' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        // Block string: ends at the first `"""` that is not the `\"""` escape.
        i += 3;
        for (;;) {
          if (i >= n) return { tokens, unterminated: true };
          if (src[i] === '\\' && src.startsWith('"""', i + 1)) {
            i += 4;
          } else if (src.startsWith('"""', i)) {
            i += 3;
            break;
          } else {
            i++;
          }
        }
      } else {
        i++;
        for (;;) {
          if (i >= n || src[i] === '\n' || src[i] === '\r') return { tokens, unterminated: true };
          if (src[i] === '\\') {
            i += 2;
          } else if (src[i] === '"') {
            i++;
            break;
          } else {
            i++;
          }
        }
      }
      tokens.push({ kind: 'string' });
      continue;
    }
    if (NAME_START.test(c)) {
      const start = i;
      i++;
      while (i < n && NAME_CONTINUE.test(src[i]!)) i++;
      tokens.push({ kind: 'name', value: src.slice(start, i) });
      continue;
    }
    tokens.push({ kind: 'punct', value: c });
    i++;
  }
  return { tokens, unterminated: false };
}

const OPEN = new Set(['{', '(', '[']);
const CLOSE = new Set(['}', ')', ']']);
const OPERATION_KEYWORDS = new Set(['query', 'mutation', 'subscription']);

interface Summary {
  kinds: string[];
  wellFormed: boolean;
}

/** Read the top-level definitions of a document. */
function summarize(document: string): Summary {
  const { tokens, unterminated } = lex(document);
  const kinds: string[] = [];
  let wellFormed = !unterminated;
  let i = 0;

  const peek = (): Token | undefined => tokens[i];
  const isPunct = (t: Token | undefined, value: string): boolean => t?.kind === 'punct' && t.value === value;

  /**
   * Skip one balanced group starting at an opening bracket. Returns false when
   * the document ends inside it.
   */
  const skipGroup = (): boolean => {
    let depth = 0;
    while (i < tokens.length) {
      const t = tokens[i++]!;
      if (t.kind !== 'punct') continue;
      if (OPEN.has(t.value)) depth++;
      else if (CLOSE.has(t.value)) {
        depth--;
        if (depth === 0) return true;
      }
    }
    return false;
  };

  /** `@name` or `@name(args)`, repeated. */
  const skipDirectives = (): boolean => {
    while (isPunct(peek(), '@')) {
      i++;
      if (peek()?.kind !== 'name') return false;
      i++;
      if (isPunct(peek(), '(') && !skipGroup()) return false;
    }
    return true;
  };

  /** The selection set that ends every executable definition. */
  const selectionSet = (): boolean => isPunct(peek(), '{') && skipGroup();

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (isPunct(t, '{')) {
      // Anonymous query shorthand.
      kinds.push('query');
      if (!skipGroup()) wellFormed = false;
      continue;
    }
    if (t.kind !== 'name') {
      // A string, stray punctuation, or a closing bracket with nothing open.
      wellFormed = false;
      i++;
      continue;
    }
    i++;
    kinds.push(t.value);
    let ok: boolean;
    if (OPERATION_KEYWORDS.has(t.value)) {
      // query/mutation/subscription Name? VariableDefinitions? Directives? SelectionSet
      if (peek()?.kind === 'name') i++;
      ok = true;
      if (isPunct(peek(), '(')) ok = skipGroup();
      ok = ok && skipDirectives() && selectionSet();
    } else if (t.value === 'fragment') {
      // fragment Name on Type Directives? SelectionSet
      ok = peek()?.kind === 'name';
      if (ok) i++;
      const on = peek();
      ok = ok && on?.kind === 'name' && on.value === 'on';
      if (ok) i++;
      ok = ok && peek()?.kind === 'name';
      if (ok) i++;
      ok = ok && skipDirectives() && selectionSet();
    } else {
      // Not an executable definition (`extend`, `type`, a typo). Skip to the
      // end of its body so its inner names are not read as definitions.
      ok = false;
      while (i < tokens.length && !isPunct(peek(), '{')) i++;
      if (i < tokens.length) skipGroup();
    }
    // On a malformed definition the unexpected token is left in place and
    // re-read as the start of the next definition, so a broken head such as
    // `query Q mutation M { … }` cannot hide the mutation behind it.
    if (!ok) wellFormed = false;
  }
  return { kinds, wellFormed };
}

/**
 * The keyword that starts each top-level definition of a GraphQL document, in
 * order: `'query'`, `'mutation'`, `'subscription'` or `'fragment'` (an
 * anonymous `{ … }` shorthand counts as `'query'`). Anything else at the top
 * level is reported verbatim (`'extend'`, a stray word), so a caller deciding
 * whether to refuse a document sees it rather than an empty list.
 *
 * Best effort on a malformed document — it keeps reading after the first
 * error — so for a yes/no "is this safe" gate prefer
 * {@link isReadOnlyGraphqlDocument}, which also refuses what it cannot parse.
 */
export function graphqlOperationKinds(document: string): string[] {
  return summarize(document).kinds;
}

/**
 * True when executing the document cannot write: it parses cleanly, contains
 * at least one `query` (or `{ … }` shorthand), and every top-level definition
 * is a `query` or a `fragment`. Any `mutation` or `subscription` — wherever it
 * sits, after a fragment or a query included — makes it NOT read-only, and so
 * does anything unrecognised: an empty or comment-only document, an
 * unterminated string, unbalanced braces, an unknown keyword.
 *
 * The bias is deliberate. A wrong "no" costs a refused passthrough call or a
 * skipped timeout retry; a wrong "yes" re-sends a write or lets a read-only
 * tool change account state.
 *
 * The whole document is judged even when an `operationName` would select one
 * operation from it: a document that carries a mutation at all is not handed
 * to a read-only path.
 */
export function isReadOnlyGraphqlDocument(document: string): boolean {
  const { kinds, wellFormed } = summarize(document);
  return wellFormed && kinds.includes('query') && kinds.every((k) => k === 'query' || k === 'fragment');
}
