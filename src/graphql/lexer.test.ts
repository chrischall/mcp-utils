/**
 * fleet-audit#1448: one GraphQL lexer behind both the operation-kind gate and
 * the document inspector, so a lexical fix cannot land in one and not the
 * other. `strict` is the inspector's fail-closed policy.
 */
import { describe, expect, it } from 'vitest';
import { lexGraphql } from './lexer.js';
import { GraphqlDocumentError, inspectGraphqlDocument } from './inspect.js';
import { isReadOnlyGraphqlDocument } from './operation-kind.js';

const kinds = (src: string, strict = false) => lexGraphql(src, { strict }).tokens.map((t) => (t.kind === 'name' || t.kind === 'punct' ? `${t.kind}:${t.value}` : t.kind));

describe('lexGraphql', () => {
  it('reads names, punctuation, spreads, strings, block strings and numbers; skips commas, comments and a leading BOM', () => {
    const doc = '﻿query Q($a: Int = -1.5e3) { ...F, b(s: "x\\"y", t: """a \\""" b""") # c\n }';
    expect(kinds(doc)).toEqual([
      'name:query', 'name:Q', 'punct:(', 'punct:$', 'name:a', 'punct::', 'name:Int', 'punct:=', 'number', 'punct:)',
      'punct:{', 'punct:...', 'name:F', 'name:b', 'punct:(', 'name:s', 'punct::', 'string', 'name:t', 'punct::', 'string', 'punct:)',
      'punct:}',
    ]);
    expect(lexGraphql(doc).error).toBeUndefined();
    expect(kinds(doc, true)).toEqual(kinds(doc));
  });

  it('reports an unterminated string or block string, in both modes', () => {
    for (const strict of [false, true]) {
      expect(lexGraphql('{ a(s: "x) }', { strict }).error).toBe('unterminated string');
      expect(lexGraphql('{ a(s: """x) }', { strict }).error).toBe('unterminated block string');
      expect(lexGraphql('{ a(s: "x\n") }', { strict }).error).toBe('unterminated string');
    }
  });

  it('lenient: any other character is punctuation (the kind gate judges it); strict: it is an error at its offset', () => {
    expect(kinds('{ a } ;')).toContain('punct:;');
    expect(lexGraphql('{ a } ;').error).toBeUndefined();
    expect(lexGraphql('{ a } ;', { strict: true }).error).toBe('unexpected character ";" at offset 6');
    expect(lexGraphql('{ a.b }', { strict: true }).error).toBe('unexpected character "." at offset 3');
  });

  it('strict refuses a BOM anywhere but the start, as the inspector always has', () => {
    expect(lexGraphql('{ a }﻿').error).toBeUndefined();
    expect(lexGraphql('{ a }﻿', { strict: true }).error).toMatch(/unexpected character/);
  });
});

describe('the gate and the inspector agree (shared lexer)', () => {
  const corpus: Array<[string, boolean]> = [
    ['{ a }', true],
    ['query Q { a: b }', true],
    ['fragment F on T { a } query Q { ...F }', true],
    ['query Q { a } mutation M { b }', false],
    ['mutation M { b }', false],
    ['subscription S { a }', false],
    ['query Q { a(s: "mutation { x }") }', true],
    ['query Q { a(s: """ \\""" mutation { x } """) }', true],
    ['# mutation M { x }\nquery Q { a }', true],
    ['query Q { a(v: "\\u0041") }', true],
    ['query Q { a @include(if: true) { b } }', true],
    ['query Q { ... { a } }', true],
    ['query Q { a(n: -12.5e-3) }', true],
  ];
  it.each(corpus)('%s', (doc, readOnly) => {
    expect(isReadOnlyGraphqlDocument(doc)).toBe(readOnly);
    const info = inspectGraphqlDocument(doc);
    expect(info.operations.every((o) => o.kind === 'query')).toBe(readOnly);
  });

  it.each(['', '# only a comment', 'Mutation { x }', 'extend type Q { a }', 'query Q { a(s: "x) }', 'query Q { a }}', '{ a } ;'])(
    'both refuse %j',
    (doc) => {
      expect(isReadOnlyGraphqlDocument(doc)).toBe(false);
      expect(() => inspectGraphqlDocument(doc)).toThrow(GraphqlDocumentError);
    },
  );
});
