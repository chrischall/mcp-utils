/**
 * GraphQL document inspection — WHAT a caller-supplied document does: its
 * operations (kind and name), the fragments it defines, every field it
 * selects, and every alias with the field behind it.
 *
 * {@link isReadOnlyGraphqlDocument} answers "query or not". A raw-GraphQL
 * escape hatch needs more: concur-mcp refuses named mutations wherever they
 * are selected (by operation name AND by field, so renaming the operation or
 * aliasing the field does not get one through) and insists on exactly one
 * operation; workday-mcp refuses an ALIASED selection of a secret- or
 * PII-named field, because an alias renames the response key its redactor
 * matches on. Lifted from concur-mcp `src/graphql-guard.ts`
 * `inspectGraphqlDocument` (the reference) with workday-mcp's alias rule
 * (`src/client.ts` `findSensitiveAlias`) folded in as {@link GraphqlDocumentInfo.aliases}
 * — chrischall/fleet-audit#1231.
 *
 * A small tokenizer feeding a cursor parser, so string, block-string and
 * comment contents can never look like a field, and argument / variable /
 * directive names are never counted. Anything it cannot read is THROWN
 * ({@link GraphqlDocumentError}), never guessed — a guard built on it fails
 * closed. A single linear pass with no backtracking regex, and selection-set
 * nesting is capped at {@link MAX_GRAPHQL_SELECTION_DEPTH}, because it runs on
 * documents a model (or an injected instruction) wrote.
 */

import { lexGraphql, type GraphqlToken } from './lexer.js';

/** One operation of a document. */
export interface GraphqlOperation {
  kind: 'query' | 'mutation' | 'subscription';
  /** The operation name; `undefined` for an anonymous operation (including the `{ … }` shorthand). */
  name: string | undefined;
}

/** One aliased selection, `alias: field`. */
export interface GraphqlAlias {
  /** The response key the caller chose. */
  alias: string;
  /** The field actually selected. */
  field: string;
}

/** What {@link inspectGraphqlDocument} reads off a document. */
export interface GraphqlDocumentInfo {
  /** Every operation, in document order. */
  operations: GraphqlOperation[];
  /** Names of the fragments the document defines. */
  fragments: string[];
  /**
   * Every field name AND alias selected anywhere (operations and fragments),
   * case preserved — so a deny-list matches an aliased field by either name.
   */
  fields: Set<string>;
  /** Every aliased selection, in document order. */
  aliases: GraphqlAlias[];
}

/** Thrown by {@link inspectGraphqlDocument} for a document it cannot read. */
export class GraphqlDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphqlDocumentError';
  }
}

/**
 * Deepest selection-set nesting {@link inspectGraphqlDocument} reads before
 * refusing the document: 64. Real documents in the fleet nest under a dozen;
 * the cap keeps a hostile `{{{{…` from recursing the parser off the stack.
 */
export const MAX_GRAPHQL_SELECTION_DEPTH = 64;

// The lexer is shared with the operation-kind gate (./lexer.ts,
// fleet-audit#1448), in its strict mode: an unknown character fails closed.
// Strings and numbers are dropped — the grammar below never reads them.
type Token = Extract<GraphqlToken, { kind: 'name' | 'punct' }>;

const OPERATION_KINDS = new Set(['query', 'mutation', 'subscription']);

function fail(message: string): never {
  throw new GraphqlDocumentError(message);
}

function tokenize(doc: string): Token[] {
  const { tokens, error } = lexGraphql(doc, { strict: true });
  if (error !== undefined) fail(error);
  return tokens.filter((t): t is Token => t.kind === 'name' || t.kind === 'punct');
}

/** A cursor over the token list with the few reads the grammar needs. */
class Cursor {
  private k = 0;
  constructor(private readonly tokens: Token[]) {}
  get done(): boolean {
    return this.k >= this.tokens.length;
  }
  peek(): Token | undefined {
    return this.tokens[this.k];
  }
  isPunct(value: string): boolean {
    const t = this.peek();
    return t?.kind === 'punct' && t.value === value;
  }
  isName(): boolean {
    return this.peek()?.kind === 'name';
  }
  next(): Token {
    const t = this.tokens[this.k++];
    if (!t) fail('unexpected end of document');
    return t;
  }
  name(): string {
    const t = this.next();
    if (t.kind !== 'name') fail(`expected a name, got ${JSON.stringify(t.value)}`);
    return t.value;
  }
  expect(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) fail(`expected ${value}, got ${JSON.stringify(t.value)}`);
  }
  /** Skip a balanced `( … )` group (arguments, variable definitions) without reading it. Iterative. */
  skipGroup(): void {
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const stack: string[] = [];
    do {
      const t = this.next();
      if (t.kind !== 'punct') continue;
      const close = pairs[t.value];
      if (close !== undefined) stack.push(close);
      else if (t.value === ')' || t.value === ']' || t.value === '}') {
        if (stack.pop() !== t.value) fail(`unbalanced ${t.value}`);
      }
    } while (stack.length > 0);
  }
}

function skipDirectives(c: Cursor): void {
  while (c.isPunct('@')) {
    c.next();
    c.name();
    if (c.isPunct('(')) c.skipGroup();
  }
}

interface Collected {
  fields: Set<string>;
  aliases: GraphqlAlias[];
}

function readSelectionSet(c: Cursor, out: Collected, depth: number): void {
  if (depth > MAX_GRAPHQL_SELECTION_DEPTH) fail(`selection sets nested too deeply (more than ${MAX_GRAPHQL_SELECTION_DEPTH})`);
  c.expect('{');
  let empty = true;
  while (!c.isPunct('}')) {
    empty = false;
    if (c.isPunct('...')) {
      c.next();
      if (c.isName() && (c.peek() as { value: string }).value === 'on') {
        c.next();
        c.name(); // type condition
        skipDirectives(c);
        readSelectionSet(c, out, depth + 1);
      } else if (c.isName()) {
        c.name(); // fragment spread
        skipDirectives(c);
      } else {
        skipDirectives(c);
        readSelectionSet(c, out, depth + 1);
      }
      continue;
    }
    const first = c.name();
    out.fields.add(first);
    if (c.isPunct(':')) {
      c.next();
      const field = c.name(); // the field behind an alias
      out.fields.add(field);
      out.aliases.push({ alias: first, field });
    }
    if (c.isPunct('(')) c.skipGroup();
    skipDirectives(c);
    if (c.isPunct('{')) readSelectionSet(c, out, depth + 1);
  }
  if (empty) fail('empty selection set');
  c.expect('}');
}

/**
 * Read a GraphQL executable document: its operations, fragment definitions,
 * selected fields (names and aliases) and aliases. Throws
 * {@link GraphqlDocumentError} on anything it cannot parse — an unterminated
 * string, unbalanced brackets, an unknown character or top-level word (a
 * type-system definition such as `extend type`, a capitalised `Mutation`), an
 * empty selection set, nesting past {@link MAX_GRAPHQL_SELECTION_DEPTH}, or a
 * document with no definitions.
 *
 * Use it beside, not instead of, {@link isReadOnlyGraphqlDocument}: that is
 * the kind check; this says which mutation, which fields, which aliases —
 *
 * ```ts
 * const info = inspectGraphqlDocument(query);
 * if (info.operations.length !== 1) throw new McpToolError('Send exactly one operation.');
 * const hit = info.aliases.find((a) => isSecretKey(a.field));     // workday's alias guard
 * const denied = [...info.fields].some((f) => DENY.has(f.toLowerCase())); // concur's deny-list
 * ```
 */
export function inspectGraphqlDocument(doc: string): GraphqlDocumentInfo {
  const c = new Cursor(tokenize(doc));
  const operations: GraphqlOperation[] = [];
  const fragments: string[] = [];
  const out: Collected = { fields: new Set<string>(), aliases: [] };

  while (!c.done) {
    if (c.isPunct('{')) {
      operations.push({ kind: 'query', name: undefined });
      readSelectionSet(c, out, 1);
      continue;
    }
    const keyword = c.name();
    if (OPERATION_KINDS.has(keyword)) {
      const name = c.isName() ? c.name() : undefined;
      if (c.isPunct('(')) c.skipGroup();
      skipDirectives(c);
      operations.push({ kind: keyword as GraphqlOperation['kind'], name });
      readSelectionSet(c, out, 1);
    } else if (keyword === 'fragment') {
      fragments.push(c.name());
      if (c.name() !== 'on') fail('fragment without a type condition');
      c.name();
      skipDirectives(c);
      readSelectionSet(c, out, 1);
    } else {
      fail(`unexpected word ${JSON.stringify(keyword)} at the top level`);
    }
  }

  if (operations.length === 0 && fragments.length === 0) fail('no definitions');
  return { operations, fragments, fields: out.fields, aliases: out.aliases };
}
