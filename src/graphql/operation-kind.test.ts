import { describe, expect, it } from 'vitest';
import { graphqlOperationKinds, isReadOnlyGraphqlDocument } from './index.js';

describe('graphqlOperationKinds', () => {
  it.each([
    ['named query', 'query X { x }', ['query']],
    ['anonymous query', 'query { x }', ['query']],
    ['shorthand selection set', '{ x }', ['query']],
    ['named mutation', 'mutation M($id: ID!) { save(id: $id) }', ['mutation']],
    ['subscription', 'subscription S { s }', ['subscription']],
    ['fragment then query', 'fragment F on T { a }\nquery Y { ...F }', ['fragment', 'query']],
    ['query then fragment', 'query Op { ...F } fragment F on T { id }', ['query', 'fragment']],
    ['fragment then mutation', 'fragment F on T { id } mutation Op { x { ...F } }', ['fragment', 'mutation']],
    ['multi-operation document', 'query Q { a } mutation Op { b }', ['query', 'mutation']],
    ['two shorthand-free queries, no separator', 'query A{a}query B{b}', ['query', 'query']],
    ['operation NAMED mutation is still a query', 'query mutation { x }', ['query']],
    ['directive named mutation on a query', 'query Q @mutation { x }', ['query']],
    ['directive with arguments', 'query Q @cached(ttl: 60, scope: "mutation") { x }', ['query']],
    ['variable defaults with lists and objects', 'query Q($a: [Int] = [1, 2], $b: In = { k: "}" }) { x }', ['query']],
    ['fragment with a directive', 'fragment F on T @include(if: true) { a }', ['fragment']],
    ['empty document', '', []],
    ['comment-only document', '# nothing here', []],
    ['unknown definition keyword', 'extend type Query { a }', ['extend']],
    ['stray leading word', 'q', ['q']],
  ])('%s', (_label, doc, kinds) => {
    expect(graphqlOperationKinds(doc)).toEqual(kinds);
  });

  it('recovers past a malformed header so a following mutation is still reported', () => {
    // `query Q` has no selection set; the server rejects the document, but a
    // best-effort reader must not let the malformed head hide the mutation.
    expect(graphqlOperationKinds('query Q mutation M { m }')).toEqual(['query', 'mutation']);
  });

  it('runs in linear time on a large adversarial document', () => {
    const big = '"""'.repeat(30_000) + '#'.repeat(50_000) + '{'.repeat(50_000) + '"\\'.repeat(30_000);
    const t0 = performance.now();
    graphqlOperationKinds(big);
    isReadOnlyGraphqlDocument(big);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe('isReadOnlyGraphqlDocument', () => {
  // hemnet-mcp tests/is-read-only-operation.test.ts + onehome-mcp
  // tests/tools/graphql.test.ts corpora, merged.
  it.each([
    ['named query', 'query X { x }'],
    ['anonymous query', 'query { x }'],
    ['shorthand selection set', '{ x }'],
    ['indented query', '\n  query X($a: Int!) { x(a: $a) }\n'],
    ['fragment before query', 'fragment F on T { a }\nquery Y { ...F }'],
    ['query plus a fragment', 'query Op { ...F } fragment F on T { id }'],
    ['comment-prefixed query', '# fetch a listing\nquery X { x }'],
    ['comment-prefixed shorthand', '# hi\n# there\n{ x }'],
    ['CRLF comment-prefixed query', '# hi\r\nquery X { x }'],
    ['CR-only comment-prefixed query', '# hi\rquery X { x }'],
    ['BOM-prefixed query', '﻿query X { x }'],
    ['BOM + comment-prefixed query', '﻿  # note\n  query X { x }'],
    ['comma-separated definitions', 'query A { a },,, query B { b }'],
    ['query with a "mutation" field and string', 'query X { mutation(s: "mutation {") { id } }'],
    ['field or alias named mutation', 'query X { mutation { id } m: mutation }'],
    ['comment containing mutation', '# mutation Old { m }\nquery X { x }'],
    ['comment inside the selection set', 'query Op {\n  # mutation Op { x }\n  a\n}'],
    ['block-string argument containing mutation', 'query X { x(d: """mutation { m }""") }'],
    ['multi-line block string', 'query Op { s(q: """\nmutation X { y }\n""") }'],
    ['escaped quote inside a string argument', 'query X { x(s: "a \\" mutation {") }'],
    ['block string with an escaped \\""" inside a query', 'query X { x(d: """a \\""" b""") }'],
    ['a $mutation variable', 'query Op($mutation: String) { a(b: $mutation) }'],
    ['operation named mutation', 'query mutation { x }'],
    ['directive named mutation', 'query Q @mutation { x }'],
  ])('%s → read-only', (_label, doc) => {
    expect(isReadOnlyGraphqlDocument(doc)).toBe(true);
  });

  it.each([
    ['named mutation', 'mutation SaveListing($id: ID!) { save(id: $id) }'],
    ['anonymous mutation', 'mutation { m }'],
    ['subscription', 'subscription S { s }'],
    ['fragment before mutation', 'fragment F on T { a }\nmutation M { m { ...F } }'],
    ['comment-prefixed mutation', '# save a listing\nmutation M { m }'],
    ['comment-prefixed mutation, no newline gap', '#c\nmutation{m}'],
    ['comment-prefixed subscription', '# live\nsubscription S { s }'],
    ['BOM + comment-prefixed mutation', '﻿# x\r\nmutation M { m }'],
    ['comment ending in a brace, then mutation', '# }\nmutation M { m }'],
    ['query followed by a mutation', 'query Q { q }\nmutation M { m }'],
    ['shorthand followed by a mutation', '{ q } mutation M { m }'],
    ['empty document', ''],
    ['whitespace-only document', '  \n\t ,'],
    ['comment-only document', '# nothing here'],
    ['fragment-only document', 'fragment F on T { a }'],
    ['unrecognised leading token', 'q'],
    ['unknown definition keyword', 'extend type Query { a }'],
    ['block string before a mutation', '"""doc"""\nmutation M { m }'],
    ['unterminated block string hiding a mutation', '"""mutation M { m }'],
    ['unterminated string', 'query X { x(s: "abc) }'],
    ['unbalanced braces', 'query X { x '],
    ['stray closing brace', 'query X { x } }'],
    ['escaped \\""" in a block string, then a real mutation', 'query X { x(d: """a \\""" b""") }\nmutation M { m }'],
    [
      'a mutation after a block string with an escaped triple quote',
      'query Q { a(s: """ \\""" """) } mutation Op { b }',
    ],
    ['a malformed query head hiding a mutation', 'query Q mutation M { m }'],
  ])('%s → NOT read-only', (_label, doc) => {
    expect(isReadOnlyGraphqlDocument(doc)).toBe(false);
  });
});
