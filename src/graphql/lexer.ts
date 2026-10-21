/**
 * The one GraphQL lexer behind {@link isReadOnlyGraphqlDocument}
 * (`operation-kind.ts`) and {@link inspectGraphqlDocument} (`inspect.ts`).
 * They are used side by side by the same guards, so they must read a
 * document identically: two tokenizers for one grammar drift, and the next
 * lexical fix lands in one and not the other (fleet-audit#1448).
 *
 * Per the GraphQL lexical grammar: a BOM, whitespace, line terminators and
 * commas are ignored; a `#` comment runs to the end of the line; strings
 * (with `\` escapes) and block strings (with the `\"""` escape) are consumed
 * whole, so their contents can never look like keywords; names are
 * `[_A-Za-z][_0-9A-Za-z]*`; a number (`-`, digits, `.`, `e`, `+`) is one
 * token; `...` is one punctuator. A single linear pass, no regex
 * backtracking — it runs on caller-supplied documents.
 *
 * Two policies, because the two callers fail closed differently:
 *  - lenient (the kind gate): any other character becomes a punctuation
 *    token, and the gate's grammar marks the document not well-formed;
 *  - `strict` (the inspector): any other character — a punctuator GraphQL
 *    does not have, a lone `.`, a BOM past the start — stops the lexer with
 *    an `error`.
 * An unterminated string or block string is an `error` in both.
 */

/** One token. Strings and numbers carry no value: no caller reads them. */
export type GraphqlToken =
  | { kind: 'name'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'string' }
  | { kind: 'number' };

/** What {@link lexGraphql} read. */
export interface GraphqlLexResult {
  /** The tokens read — up to the error, when there is one. */
  tokens: GraphqlToken[];
  /** Why lexing stopped early (`'unterminated string'`, …); `undefined` when it read the whole document. */
  error?: string;
}

/** The punctuators of the GraphQL grammar (besides `...`). */
const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);
const NAME_START = /[_A-Za-z]/;
const NAME_PART = /[_0-9A-Za-z]/;
const NUMBER_PART = /[-+.0-9eE]/;
const BOM = '﻿';

/** Tokenize a GraphQL document. See the module docblock for the two policies. */
export function lexGraphql(doc: string, opts: { strict?: boolean } = {}): GraphqlLexResult {
  const strict = opts.strict === true;
  const tokens: GraphqlToken[] = [];
  const n = doc.length;
  let i = 0;
  while (i < n) {
    const c = doc[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || (c === BOM && (i === 0 || !strict))) {
      i++;
    } else if (c === '#') {
      while (i < n && doc[i] !== '\n' && doc[i] !== '\r') i++;
    } else if (doc.startsWith('"""', i)) {
      // Block string: ends at the first `"""` that is not the `\"""` escape.
      i += 3;
      for (;;) {
        if (i >= n) return { tokens, error: 'unterminated block string' };
        if (doc.startsWith('\\"""', i)) i += 4;
        else if (doc.startsWith('"""', i)) {
          i += 3;
          break;
        } else i++;
      }
      tokens.push({ kind: 'string' });
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= n || doc[i] === '\n' || doc[i] === '\r') return { tokens, error: 'unterminated string' };
        if (doc[i] === '\\') i += 2;
        else if (doc[i] === '"') {
          i++;
          break;
        } else i++;
      }
      tokens.push({ kind: 'string' });
    } else if (doc.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
    } else if (NAME_START.test(c)) {
      const start = i;
      while (i < n && NAME_PART.test(doc[i]!)) i++;
      tokens.push({ kind: 'name', value: doc.slice(start, i) });
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      while (i < n && NUMBER_PART.test(doc[i]!)) i++;
      tokens.push({ kind: 'number' });
    } else if (PUNCT.has(c) || !strict) {
      tokens.push({ kind: 'punct', value: c });
      i++;
    } else {
      return { tokens, error: `unexpected character ${JSON.stringify(c)} at offset ${i}` };
    }
  }
  return { tokens };
}
