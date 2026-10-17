/**
 * fleet-audit#1231: concur-mcp `src/graphql-guard.ts` `inspectGraphqlDocument`
 * (the reference — a tokenizer + cursor parser) and workday-mcp's
 * `lexGraphql` / `findSensitiveAlias` answer the same two questions beyond
 * isReadOnlyGraphqlDocument: which operations and fields a caller-supplied
 * document selects, and which of them are aliased. concur's own cases first.
 */
import { describe, expect, it } from 'vitest';
import { GraphqlDocumentError, MAX_GRAPHQL_SELECTION_DEPTH, inspectGraphqlDocument } from './index.js';

describe('inspectGraphqlDocument (concur cases)', () => {
  it('reads operations, field names and aliases, skipping arguments, variables, directives and fragment refs', () => {
    const doc = `# a comment mentioning submit
      mutation Save($submit: Boolean = true, $obj: In = {submit: 1}) {
        travel @skip(if: $submit) {
          renamed: trip(note: "submit hold") {
            ...TripBits
            ... on TravelTrip { tripId }
          }
        }
      }
      fragment TripBits on TravelTrip { name description }`;
    const info = inspectGraphqlDocument(doc);
    expect(info.operations).toEqual([{ kind: 'mutation', name: 'Save' }]);
    expect(info.fragments).toEqual(['TripBits']);
    expect([...info.fields].sort()).toEqual(['description', 'name', 'renamed', 'travel', 'trip', 'tripId'].sort());
    expect(info.aliases).toEqual([{ alias: 'renamed', field: 'trip' }]);
  });

  it('treats a `{ … }` shorthand as an anonymous query', () => {
    expect(inspectGraphqlDocument('{ employee { userId } }').operations).toEqual([{ kind: 'query', name: undefined }]);
  });

  it('ignores block-string contents (with escaped triple quotes)', () => {
    const info = inspectGraphqlDocument('mutation { x(a: """ hold \\""" submit """) { y } }');
    expect([...info.fields].sort()).toEqual(['x', 'y']);
  });

  it('reads a leading BOM, escaped quotes, directive arguments and untyped inline fragments', () => {
    const info = inspectGraphqlDocument('﻿query { a(s: "q\\"hold\\"") @include(if: true) { ... @skip(if: false) { b } ... { c @client } } }');
    expect(info.operations).toEqual([{ kind: 'query', name: undefined }]);
    expect([...info.fields].sort()).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['unterminated string', 'mutation { x(a: "oops) { y } }'],
    ['unterminated block string', 'mutation { x(a: """ oops) { y } }'],
    ['a missing selection set', 'query X }'],
    ['mismatched brackets in arguments', 'query X($a: [Int) { y }'],
    ['an empty selection set', 'query { }'],
    ['a fragment without a type condition', 'fragment F X { a }'],
    ['unbalanced braces', 'mutation { x { y }'],
    ['stray closer', 'mutation { x } }'],
    ['unknown character', 'mutation { x % y }'],
    ['empty document', '   # only a comment'],
    ['unknown top-level word', 'extend type X { y: Int }'],
  ])('throws a GraphqlDocumentError on a malformed document (%s)', (_label, doc) => {
    expect(() => inspectGraphqlDocument(doc)).toThrow(GraphqlDocumentError);
  });
});

describe('inspectGraphqlDocument — what workday needs', () => {
  it('lists every alias with the field behind it, in document order, across operations and fragments', () => {
    const info = inspectGraphqlDocument(
      'query { worker { a: nationalIdentifier b: name(x: 1) { c: first } } } fragment F on W { d: bankAccountNumber }',
    );
    expect(info.aliases).toEqual([
      { alias: 'a', field: 'nationalIdentifier' },
      { alias: 'b', field: 'name' },
      { alias: 'c', field: 'first' },
      { alias: 'd', field: 'bankAccountNumber' },
    ]);
  });

  it('never reads a colon in a variable definition, an argument or an object value as an alias', () => {
    const info = inspectGraphqlDocument('query Q($id: ID = "a:b") { worker(id: $id, f: { k: 1 }) { name } }');
    expect(info.aliases).toEqual([]);
  });

  it('counts several operations, so a caller can insist on exactly one', () => {
    expect(inspectGraphqlDocument('query A { a } query B { b }').operations).toHaveLength(2);
  });

  it('reports kinds in lower case only — a capitalised keyword is an unknown word', () => {
    expect(() => inspectGraphqlDocument('Mutation { x }')).toThrow(/unexpected word "Mutation"/);
  });
});

describe('inspectGraphqlDocument on hostile input', () => {
  it(`refuses nesting deeper than ${MAX_GRAPHQL_SELECTION_DEPTH} instead of recursing`, () => {
    const deep = `query ${'{ a '.repeat(MAX_GRAPHQL_SELECTION_DEPTH + 1)}${'}'.repeat(MAX_GRAPHQL_SELECTION_DEPTH + 1)}`;
    expect(() => inspectGraphqlDocument(deep)).toThrow(/nested too deeply/);
    const ok = `query ${'{ a '.repeat(MAX_GRAPHQL_SELECTION_DEPTH)}${'}'.repeat(MAX_GRAPHQL_SELECTION_DEPTH)}`;
    expect(inspectGraphqlDocument(ok).fields).toEqual(new Set(['a']));
  });

  it.each([
    ['opening braces', '{'.repeat(200_000)],
    ['nested fields', `query ${'{ a '.repeat(50_000)}`],
    ['an unterminated block string', `query { a(s: """${'x'.repeat(200_000)}) }`],
    ['backslashes in a string', `query { a(s: "${'\\\\'.repeat(100_000)}") }`],
    ['comments', `# ${'x'.repeat(200_000)}\nquery { a }`],
    ['argument brackets', `query { a(${'['.repeat(100_000)}) }`],
    ['many fields', `query { ${'a '.repeat(100_000)}}`],
  ])('stays linear on 200 KB of %s', (_label, doc) => {
    const t = performance.now();
    try {
      inspectGraphqlDocument(doc);
    } catch {
      /* malformed is fine — the time is what is measured */
    }
    expect(performance.now() - t).toBeLessThan(100);
  });
});
