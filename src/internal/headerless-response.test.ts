import { describe, expect, it, vi } from 'vitest';

import { sessionLoginFlow } from '../auth/index.js';
import { createGraphqlClient } from '../graphql/index.js';
import { RateLimitedError, UnauthorizedError, createApiClient } from '../http/index.js';

/**
 * A fake `fetch` answer with no `headers` at all — the shape a hand-rolled
 * test double or a non-standard fetch shim returns. 2.13.0 started reading
 * `Retry-After` off the final 429, and ioffice-mcp / splitwise-mcp's suites
 * crashed on exactly this object with "Cannot read properties of undefined
 * (reading 'get')". Every header read in the library must treat a missing
 * `headers` as "no headers", never throw a TypeError.
 */
function headerless(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    url: 'https://api.example.com/x',
    body: null,
    text: async () => body,
    json: async () => JSON.parse(body || 'null'),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    clone() {
      return headerless(status, body);
    },
  } as unknown as Response;
}

function api(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createApiClient({
    baseUrl: 'https://api.example.com',
    serviceName: 'Example',
    fetchImpl,
    sleep: async () => {},
    ...extra,
  } as Parameters<typeof createApiClient>[0]);
}

describe('a response with no headers object never crashes a header read', () => {
  it('createApiClient: an exhausted 429 is still a RateLimitedError (no hook)', async () => {
    const fetchImpl = vi.fn(async () => headerless(429)) as unknown as typeof fetch;
    await expect(api(fetchImpl).fetchJson('GET', '/x')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('createApiClient: honorRetryAfter on a headerless 429 falls back to the default delay', async () => {
    const replies = [headerless(429), headerless(200, '{"ok":true}')];
    const fetchImpl = vi.fn(async () => replies.shift()!) as unknown as typeof fetch;
    const client = api(fetchImpl, { retry: { count: 1, delayMs: 5, honorRetryAfter: true } });
    await expect(client.fetchJson('GET', '/x')).resolves.toEqual({ ok: true });
  });

  it('createApiClient: the onRateLimited hook gets a null retryAfter', async () => {
    const fetchImpl = vi.fn(async () => headerless(429)) as unknown as typeof fetch;
    const onRateLimited = vi.fn(() => new Error('limited'));
    await expect(api(fetchImpl, { onRateLimited }).fetchJson('GET', '/x')).rejects.toThrow('limited');
    expect(onRateLimited).toHaveBeenCalledWith(expect.objectContaining({ status: 429, retryAfter: null, edgeBlock: null }));
  });

  it('createApiClient: a headerless 401 is still an UnauthorizedError', async () => {
    const fetchImpl = vi.fn(async () => headerless(401, 'nope')) as unknown as typeof fetch;
    await expect(api(fetchImpl).fetchJson('GET', '/x')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('createGraphqlClient: a headerless 429 is a RateLimitedError, not a TypeError', async () => {
    const fetchImpl = vi.fn(async () => headerless(429)) as unknown as typeof fetch;
    const gql = createGraphqlClient({
      endpoint: 'https://api.example.com/graphql',
      serviceName: 'Example',
      fetchImpl,
      sleep: async () => {},
      retry: { count: 1, delayMs: 1, honorRetryAfter: true },
    });
    await expect(gql.execute({ query: '{ me { id } }' })).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('sessionLoginFlow: headerless responses read as "no cookies" — the normal missing-cookie error, not a TypeError', async () => {
    const page = headerless(200, '<input name="csrfToken" value="tok123">');
    const post = headerless(200, '{}');
    const replies = [page, post];
    const fetchImpl = vi.fn(async () => replies.shift()!) as unknown as typeof fetch;
    const run = sessionLoginFlow({
      loginUrl: 'https://example.com/login',
      postUrl: 'https://example.com/login',
      csrfRegex: /name="csrfToken" value="([^"]+)"/,
      email: 'a@example.com',
      password: 'pw',
      fetchImpl,
    } as Parameters<typeof sessionLoginFlow>[0]);
    const err = await run.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/did not yield/);
  });
});
