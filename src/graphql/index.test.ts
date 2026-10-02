import { describe, expect, it, vi } from 'vitest';
import { withCallSignal } from '../cancel/index.js';
import { McpToolError } from '../errors/index.js';
import { EdgeBlockedError, RateLimitedError, UnauthorizedError, UpstreamHttpError } from '../http/index.js';
import {
  GraphqlResponseError,
  GraphqlTransportError,
  createGraphqlClient,
  graphqlErrorCode,
  isGraphqlAuthError,
  type GraphqlClientOptions,
} from './index.js';

const ENDPOINT = 'https://api.example.test/v2/graphql';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch fake answering each call from `replies` in order (the last repeats). */
function fakeFetch(...replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> | undefined }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      init,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
    return new Response(text, {
      status: reply.status ?? 200,
      headers: { 'content-type': typeof reply.body === 'string' ? 'text/html' : 'application/json', ...reply.headers },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, extra: Partial<GraphqlClientOptions> = {}) {
  return createGraphqlClient({
    endpoint: ENDPOINT,
    serviceName: 'Example',
    fetchImpl,
    sleep: async () => {},
    ...extra,
  });
}

describe('createGraphqlClient — request shape', () => {
  it('POSTs {query, variables, operationName} as JSON and returns data', async () => {
    const { impl, calls } = fakeFetch({ body: { data: { me: { id: '1' } } } });
    const data = await client(impl).request<{ me: { id: string } }>('query Me { me { id } }', { a: 1 }, {
      operationName: 'Me',
    });
    expect(data).toEqual({ me: { id: '1' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ENDPOINT);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ query: 'query Me { me { id } }', variables: { a: 1 }, operationName: 'Me' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('application/json');
  });

  it('omits variables and operationName when not given (thumbtack shape)', async () => {
    const { impl, calls } = fakeFetch({ body: { data: { x: 1 } } });
    await client(impl).request('{ x }');
    expect(calls[0]!.body).toEqual({ query: '{ x }' });
  });

  it('merges static, dynamic and per-request headers in that order', async () => {
    const { impl, calls } = fakeFetch({ body: { data: {} } });
    const c = client(impl, {
      headers: async () => ({ 'x-token': 'tok', origin: 'https://www.example.test', 'x-a': 'client' }),
    });
    await c.request('{ x }', undefined, { headers: { 'x-a': 'request' } });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-token']).toBe('tok');
    expect(headers.origin).toBe('https://www.example.test');
    expect(headers['x-a']).toBe('request');
  });

  it('re-reads dynamic headers on every request', async () => {
    const { impl, calls } = fakeFetch({ body: { data: {} } });
    let n = 0;
    const c = client(impl, { headers: () => ({ 'x-token': `t${++n}` }) });
    await c.request('{ x }');
    await c.request('{ x }');
    expect(calls.map((c) => (c.init.headers as Record<string, string>)['x-token'])).toEqual(['t1', 't2']);
  });
});

describe('createGraphqlClient — errors[]', () => {
  it('treats errors[] on HTTP 200 as failure, joining and redacting messages', async () => {
    const { impl } = fakeFetch({
      body: {
        data: { partial: true },
        errors: [
          { message: 'first problem', extensions: { code: 'BAD_USER_INPUT' } },
          { message: 'leaked Bearer abcdefghijklmnopqrstuvwxyz0123456789' },
          {},
        ],
      },
    });
    const err = await client(impl).request('{ x }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphqlResponseError);
    expect(err).toBeInstanceOf(McpToolError);
    const e = err as GraphqlResponseError;
    expect(e.message).toMatch(/^Example GraphQL error: first problem; leaked Bearer \[REDACTED\]; Unknown error$/);
    expect(e.message).not.toContain('abcdefghij');
    expect(e.status).toBe(200);
    expect(e.data).toEqual({ partial: true });
    expect(e.errors).toHaveLength(3);
    expect(e.codes).toEqual(['BAD_USER_INPUT']);
  });

  it('truncates a very long error message', async () => {
    const { impl } = fakeFetch({ body: { errors: [{ message: 'x'.repeat(5000) }] } });
    const err = (await client(impl).request('{ x }').catch((e: unknown) => e)) as Error;
    expect(err.message.length).toBeLessThan(700);
  });

  it('carries a configured hint on the errors[] error', async () => {
    const { impl } = fakeFetch({ body: { errors: [{ message: 'badRequest' }] } });
    const err = (await client(impl, { errorHint: 'servicePage needs its full input.' })
      .request('{ x }')
      .catch((e: unknown) => e)) as McpToolError;
    expect(err.hint).toBe('servicePage needs its full input.');
  });

  it('normalizes a non-array errors value and string entries', async () => {
    const { impl } = fakeFetch({ body: { errors: { message: 'single object' } } }, { body: { errors: ['plain string'] } });
    const c = client(impl);
    await expect(c.request('{ x }')).rejects.toThrow('Example GraphQL error: single object');
    await expect(c.request('{ x }')).rejects.toThrow('Example GraphQL error: plain string');
  });

  it('reads errors[] from a 4xx JSON body (Apollo validation 400)', async () => {
    const { impl } = fakeFetch({ status: 400, body: { errors: [{ message: 'Cannot query field "nope"' }] } });
    const err = (await client(impl).request('{ nope }').catch((e: unknown) => e)) as GraphqlResponseError;
    expect(err).toBeInstanceOf(GraphqlResponseError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('Cannot query field');
  });

  it('a 5xx JSON body without errors[] is an UpstreamHttpError', async () => {
    const { impl } = fakeFetch({ status: 503, body: { oops: true } });
    const err = (await client(impl, { retry: { count: 0, delayMs: 0 } })
      .request('{ x }')
      .catch((e: unknown) => e)) as UpstreamHttpError;
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect(err.status).toBe(503);
  });

  it('a non-JSON error page maps to UpstreamHttpError with a redacted excerpt', async () => {
    const { impl } = fakeFetch({ status: 502, body: '<html>Bad gateway https://x.test/cb?access_token=supersecretvalue123</html>' });
    const err = (await client(impl).request('{ x }').catch((e: unknown) => e)) as UpstreamHttpError;
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect(err.status).toBe(502);
    expect(err.message).toContain('Example error 502 for POST /v2/graphql');
    expect(err.message).not.toContain('supersecretvalue123');
  });

  it('a non-JSON 2xx is reported as a challenge/error page, not data', async () => {
    const { impl } = fakeFetch({ status: 200, body: '<html>hello</html>' });
    const err = (await client(impl).request('{ x }').catch((e: unknown) => e)) as GraphqlResponseError;
    expect(err).toBeInstanceOf(GraphqlResponseError);
    expect(err.message).toMatch(/non-JSON body \(HTTP 200\)/);
  });

  it('a JSON array or empty body is not a GraphQL response', async () => {
    const { impl } = fakeFetch({ body: [1, 2] }, { body: '' });
    const c = client(impl);
    await expect(c.request('{ x }')).rejects.toBeInstanceOf(GraphqlResponseError);
    await expect(c.request('{ x }')).rejects.toBeInstanceOf(GraphqlResponseError);
  });

  it('a 200 with neither data nor errors is an empty response', async () => {
    const { impl } = fakeFetch({ body: {} }, { body: { data: null } });
    const c = client(impl);
    await expect(c.request('{ x }')).rejects.toThrow('Example GraphQL API returned an empty response.');
    await expect(c.request('{ x }')).rejects.toThrow('empty response');
  });

  it('mapError runs first and may claim an error (vibo permission denial)', async () => {
    const { impl } = fakeFetch({ body: { errors: [{ message: 'nope', code: 'FORBIDDEN' }] } });
    const denied = new McpToolError('permission denied');
    const mapError = vi.fn(({ errors }: { errors: readonly { code?: string }[] }) =>
      errors.some((e) => e.code === 'FORBIDDEN') ? denied : undefined,
    );
    await expect(client(impl, { mapError }).request('{ x }')).rejects.toBe(denied);
    expect(mapError).toHaveBeenCalledWith(expect.objectContaining({ status: 200, data: undefined }));
  });

  it('execute() returns the whole envelope without throwing on errors[] (raw passthrough tools)', async () => {
    const { impl } = fakeFetch({ status: 200, body: { data: { a: 1 }, errors: [{ message: 'partial' }], extensions: { cost: 3 } } });
    const res = await client(impl).execute({ query: '{ a }' });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ a: 1 });
    expect(res.errors).toEqual([{ message: 'partial' }]);
    expect(res.extensions).toEqual({ cost: 3 });
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});

describe('createGraphqlClient — auth', () => {
  it('maps HTTP 401 to UnauthorizedError by default', async () => {
    const { impl } = fakeFetch({ status: 401, body: { message: 'no' } });
    await expect(client(impl).request('{ x }')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('maps an UNAUTHENTICATED code on HTTP 200 to the onUnauthorized error', async () => {
    const { impl } = fakeFetch({ body: { errors: [{ message: 'login', extensions: { code: 'UNAUTHENTICATED' } }] } });
    const custom = new McpToolError('sign in again');
    await expect(client(impl, { onUnauthorized: () => custom }).request('{ x }')).rejects.toBe(custom);
  });

  it('re-authenticates once and replays with fresh headers (vibo refresh path)', async () => {
    const { impl, calls } = fakeFetch(
      { body: { errors: [{ message: 'expired', code: 'UNAUTHORIZED' }] } },
      { body: { data: { ok: true } } },
    );
    let token = 'old';
    const onAuthError = vi.fn(async () => {
      token = 'new';
    });
    const data = await client(impl, { headers: () => ({ 'x-token': token }), onAuthError }).request('mutation M { m }');
    expect(data).toEqual({ ok: true });
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => (c.init.headers as Record<string, string>)['x-token'])).toEqual(['old', 'new']);
  });

  it('replays at most once — a second auth failure throws', async () => {
    const { impl, calls } = fakeFetch({ status: 401, body: { errors: [{ message: 'expired' }] } });
    const onAuthError = vi.fn(async () => {});
    await expect(client(impl, { onAuthError }).request('{ x }')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it('a custom isAuthError widens detection (message fallback)', async () => {
    const { impl } = fakeFetch({ body: { errors: [{ message: 'Not authorized. Try to log in' }] } });
    const isAuthError = (status: number, errors: readonly { message?: string }[]) =>
      status === 401 || errors.some((e) => /not authoriz/i.test(e.message ?? ''));
    await expect(client(impl, { isAuthError }).request('{ x }')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('FORBIDDEN is not an auth error by default (refreshing cannot fix a permission denial)', async () => {
    const { impl } = fakeFetch({ body: { errors: [{ message: 'no', code: 'FORBIDDEN' }] } });
    const onAuthError = vi.fn(async () => {});
    await expect(client(impl, { onAuthError }).request('{ x }')).rejects.toBeInstanceOf(GraphqlResponseError);
    expect(onAuthError).not.toHaveBeenCalled();
  });
});

describe('isGraphqlAuthError / graphqlErrorCode', () => {
  it('reads a top-level code or extensions.code', () => {
    expect(graphqlErrorCode({ code: 'A' })).toBe('A');
    expect(graphqlErrorCode({ extensions: { code: 'B' } })).toBe('B');
    expect(graphqlErrorCode({ message: 'x' })).toBeUndefined();
  });

  it('is true for 401 or an UNAUTHENTICATED / UNAUTHORIZED code', () => {
    expect(isGraphqlAuthError(401, [])).toBe(true);
    expect(isGraphqlAuthError(200, [{ extensions: { code: 'UNAUTHENTICATED' } }])).toBe(true);
    expect(isGraphqlAuthError(200, [{ code: 'UNAUTHORIZED' }])).toBe(true);
    expect(isGraphqlAuthError(200, [{ code: 'FORBIDDEN' }])).toBe(false);
    expect(isGraphqlAuthError(403, [])).toBe(false);
  });
});

describe('createGraphqlClient — edge blocks', () => {
  it('a CloudFront refusal page on 403 is an EdgeBlockedError, not a permission or auth error', async () => {
    const { impl } = fakeFetch({
      status: 403,
      body: '<HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD></HTML>',
    });
    const err = (await client(impl).request('{ x }').catch((e: unknown) => e)) as EdgeBlockedError;
    expect(err).toBeInstanceOf(EdgeBlockedError);
    expect(err.vendor).toBe('CloudFront');
    expect(err.status).toBe(403);
  });

  it('a 401 that is an edge refusal does not trigger re-auth', async () => {
    const { impl } = fakeFetch({ status: 401, body: '<html>Incapsula incident ID: 123</html>' });
    const onAuthError = vi.fn(async () => {});
    await expect(client(impl, { onAuthError }).request('{ x }')).rejects.toBeInstanceOf(EdgeBlockedError);
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('cf-mitigated: challenge is an edge block', async () => {
    const { impl } = fakeFetch({ status: 403, body: '<html></html>', headers: { 'cf-mitigated': 'challenge' } });
    await expect(client(impl).request('{ x }')).rejects.toBeInstanceOf(EdgeBlockedError);
  });

  it('a Cloudflare challenge served with HTTP 200 is an edge block, not a non-JSON error', async () => {
    const { impl } = fakeFetch({
      status: 200,
      body: '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
    });
    await expect(client(impl).request('{ x }')).rejects.toBeInstanceOf(EdgeBlockedError);
  });
});

describe('createGraphqlClient — retry', () => {
  it('retries a 429 once by default, honouring the sleep', async () => {
    const { impl, calls } = fakeFetch({ status: 429, body: {} }, { body: { data: { ok: 1 } } });
    const sleep = vi.fn(async () => {});
    await expect(client(impl, { sleep }).request('{ x }')).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('an exhausted 429 is a RateLimitedError (or onRateLimited)', async () => {
    const { impl } = fakeFetch({ status: 429, body: {} });
    await expect(client(impl).request('{ x }')).rejects.toBeInstanceOf(RateLimitedError);
    const custom = new Error('slow down');
    await expect(client(impl, { onRateLimited: () => custom }).request('{ x }')).rejects.toBe(custom);
  });

  it('hands onRateLimited the final 429 status and Retry-After', async () => {
    const { impl } = fakeFetch({ status: 429, body: {}, headers: { 'retry-after': '12' } });
    const seen: unknown[] = [];
    await expect(
      client(impl, { retry: { count: 0, delayMs: 0 }, onRateLimited: (ctx) => (seen.push(ctx), new Error('rl')) }).request('{ x }'),
    ).rejects.toThrow('rl');
    expect(seen).toEqual([
      { status: 429, retryAfter: '12', retryAfterMs: 12_000, edgeBlock: null, method: 'POST', path: expect.any(String) },
    ]);
  });

  it('an exhausted 429 RateLimitedError carries retryAfterMs', async () => {
    const { impl } = fakeFetch({ status: 429, body: {}, headers: { 'retry-after': '5' } });
    const err = await client(impl, { retry: { count: 0, delayMs: 0 } }).request('{ x }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(5000);
  });

  it('honours Retry-After when asked', async () => {
    const { impl } = fakeFetch({ status: 429, body: {}, headers: { 'retry-after': '3' } }, { body: { data: {} } });
    const sleep = vi.fn(async () => {});
    await client(impl, { sleep, retry: { count: 1, delayMs: 10, honorRetryAfter: true } }).request('{ x }');
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('retries a configured 5xx for a query', async () => {
    const { impl, calls } = fakeFetch({ status: 503, body: 'down' }, { body: { data: { ok: 1 } } });
    await client(impl, { retry: { count: 1, delayMs: 0, statuses: [429, 503] } }).request('{ x }');
    expect(calls).toHaveLength(2);
  });

  it('never retries a 5xx for a mutation — the write may have landed', async () => {
    const { impl, calls } = fakeFetch({ status: 503, body: 'down' }, { body: { data: { ok: 1 } } });
    await expect(
      client(impl, { retry: { count: 1, delayMs: 0, statuses: [429, 503] } }).request('mutation M { m }'),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(calls).toHaveLength(1);
  });

  it('retries a 5xx for a mutation the caller marked idempotent', async () => {
    const { impl, calls } = fakeFetch({ status: 503, body: 'down' }, { body: { data: { ok: 1 } } });
    await client(impl, { retry: { count: 1, delayMs: 0, statuses: [429, 503] } }).request('mutation signIn { s }', {}, {
      idempotent: true,
    });
    expect(calls).toHaveLength(2);
  });

  it('still retries a 429 for a mutation (the request was refused, not processed)', async () => {
    const { impl, calls } = fakeFetch({ status: 429, body: {} }, { body: { data: { ok: 1 } } });
    await client(impl).request('mutation M { m }');
    expect(calls).toHaveLength(2);
  });
});

describe('createGraphqlClient — transport failures', () => {
  it('a dropped connection on a query is a retryable transport error with a redacted cause message', async () => {
    const { impl } = fakeFetch(new TypeError('fetch failed for https://x.test/g?access_token=supersecretvalue123'));
    const err = (await client(impl).request('{ x }').catch((e: unknown) => e)) as GraphqlTransportError;
    expect(err).toBeInstanceOf(GraphqlTransportError);
    expect(err.timedOut).toBe(false);
    expect(err.outcomeUnknown).toBe(false);
    expect(err.message).toMatch(/^Request to Example failed/);
    expect(err.message).not.toContain('supersecretvalue123');
    expect(err.hint).toMatch(/retry/i);
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('a dropped connection on a mutation is an unknown outcome', async () => {
    const { impl } = fakeFetch(new TypeError('socket hang up'));
    const err = (await client(impl).request('# note\nfragment F on T { a }\nmutation M { m { ...F } }').catch(
      (e: unknown) => e,
    )) as GraphqlTransportError;
    expect(err.outcomeUnknown).toBe(true);
    expect(err.message).toMatch(/may already have been applied/);
    expect(err.hint).toMatch(/Do not repeat this write blindly/);
  });

  it('a write hint can be customised', async () => {
    const { impl } = fakeFetch(new TypeError('socket hang up'));
    const err = (await client(impl, { writeOutcomeHint: 'check vibo_list_event_users first' })
      .request('mutation M { m }')
      .catch((e: unknown) => e)) as GraphqlTransportError;
    expect(err.hint).toBe('check vibo_list_event_users first');
  });

  it('an idempotent mutation (sign-in) failing is reported as a plain retryable failure', async () => {
    const { impl } = fakeFetch(new TypeError('socket hang up'));
    const err = (await client(impl)
      .request('mutation signIn { s }', {}, { idempotent: true })
      .catch((e: unknown) => e)) as GraphqlTransportError;
    expect(err.outcomeUnknown).toBe(false);
  });

  it('times out a request whose response never arrives', async () => {
    const impl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    const err = (await client(impl, { timeout: 20 }).request('{ x }').catch((e: unknown) => e)) as GraphqlTransportError;
    expect(err).toBeInstanceOf(GraphqlTransportError);
    expect(err.timedOut).toBe(true);
    expect(err.message).toBe('Request to Example timed out after 20ms.');
  });

  it('times out a body that stalls after the headers, even if fetch ignores the signal', async () => {
    const impl = vi.fn(async () => {
      const body = new ReadableStream({ start() {} }); // never enqueues, never closes
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const err = (await client(impl, { timeout: 20 }).request('mutation M { m }').catch((e: unknown) => e)) as GraphqlTransportError;
    expect(err.timedOut).toBe(true);
    expect(err.outcomeUnknown).toBe(true);
    expect(err.message).toMatch(/^Request to Example timed out after 20ms — the change may already have been applied/);
  });

  it('a timeout of 0 disables the timer', async () => {
    const { impl, calls } = fakeFetch({ body: { data: { ok: 1 } } });
    await client(impl, { timeout: 0 }).request('{ x }');
    expect(calls[0]!.init.signal).toBeUndefined();
  });

  it("hands fetch a signal the CALLER can trip, and rethrows the caller's abort untouched", async () => {
    const impl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    const caller = new AbortController();
    const pending = withCallSignal(caller.signal, () => client(impl, { timeout: 10_000 }).request('{ x }'));
    await new Promise((r) => setTimeout(r, 5));
    caller.abort();
    const err = (await pending.catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(GraphqlTransportError);
    expect(err.name).toBe('AbortError');
  });
});
