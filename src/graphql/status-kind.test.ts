/**
 * The GraphQL client's errors declare a structured `kind` beside `status`,
 * so tock-style `/auth|sign|login/` regexes (which matched "assign") can go
 * (fleet audit 2026-09, cluster 8).
 */
import { describe, it, expect } from 'vitest';
import { errorKindOf, errorStatusOf } from '../errors/index.js';
import { GraphqlResponseError, GraphqlTransportError, createGraphqlClient } from './index.js';

function replying(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

const AUTH_BODY = { errors: [{ message: 'expired', extensions: { code: 'UNAUTHENTICATED' } }] };

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('GraphqlResponseError status / kind', () => {
  it('takes an explicit kind, and declares none by default', () => {
    expect(new GraphqlResponseError('x', { status: 200, kind: 'credential_rejected' }).kind).toBe('credential_rejected');
    const plain = new GraphqlResponseError('x', {
      status: 200,
      errors: [{ message: 'assignment failed', extensions: { code: 'FORBIDDEN' } }],
    });
    expect(plain.kind).toBeUndefined();
    expect(errorStatusOf(plain)).toBe(200);
  });

  it('an UNAUTHENTICATED answer on HTTP 200 reaches the caller as credential_rejected', async () => {
    const c = createGraphqlClient({ endpoint: 'https://api.example.test/graphql', serviceName: 'Example', fetchImpl: replying(AUTH_BODY), sleep: async () => {} });
    const err = await rejection(c.request('{ me { id } }'));
    expect(errorKindOf(err)).toBe('credential_rejected');
  });

  it('a consumer that says the answer is NOT auth is not overruled', async () => {
    const c = createGraphqlClient({
      endpoint: 'https://api.example.test/graphql',
      serviceName: 'Example',
      fetchImpl: replying(AUTH_BODY),
      sleep: async () => {},
      isAuthError: () => false,
    });
    const err = await rejection(c.request('{ me { id } }'));
    expect(err).toBeInstanceOf(GraphqlResponseError);
    expect(errorKindOf(err)).toBeUndefined();
    expect(errorStatusOf(err)).toBe(200);
  });
});

describe('GraphqlTransportError kind', () => {
  it('is timeout when timed out, transport otherwise', () => {
    const base = { outcomeUnknown: false, hint: 'h', cause: undefined };
    expect(new GraphqlTransportError('x', { ...base, timedOut: true }).kind).toBe('timeout');
    expect(new GraphqlTransportError('x', { ...base, timedOut: false }).kind).toBe('transport');
  });
});
