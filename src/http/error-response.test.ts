/**
 * fleet-audit#1380: honeybook-mcp's `hbApiRequest` could not move onto
 * createApiClient because the client only exposes a redacted, truncated
 * message for an error response. HoneyBook needs the raw body twice — a dead
 * credential is disguised as a 404 with an `HBUnauthorizedError` body, and an
 * `HBWrongAPIVersionError` carries the version to retry with — and one
 * duplicate-call-prevention id per logical request, reused on every retry.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError, EdgeBlockedError, createApiClient, type ApiClientOptions } from './index.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(fetchImpl: typeof fetch, extra: Partial<ApiClientOptions> = {}) {
  return createApiClient({ baseUrl: 'https://api.test', serviceName: 'HoneyBook', fetchImpl, sleep: async () => {}, ...extra });
}

const headersOf = (call: unknown[]): Record<string, string> => (call[1] as RequestInit).headers as Record<string, string>;

describe('onErrorResponse', () => {
  it('sees the RAW body, status, method, path and headers of an error response', async () => {
    const seen = vi.fn(() => undefined);
    const fetchImpl = vi.fn(async () => json(404, { error_type: 'HBUnauthorizedError', token: 'not-redacted-here' }, { 'x-req': 'r1' }));
    await expect(client(fetchImpl as unknown as typeof fetch, { onErrorResponse: seen }).fetchJson('GET', '/api/v2/x')).rejects.toBeInstanceOf(ApiError);
    expect(seen).toHaveBeenCalledOnce();
    const ctx = (seen.mock.calls[0] as unknown[])[0] as { status: number; method: string; path: string; body: string; headers: Headers; retried: boolean };
    expect(ctx.status).toBe(404);
    expect(ctx.method).toBe('GET');
    expect(ctx.path).toBe('/api/v2/x');
    expect(ctx.body).toContain('HBUnauthorizedError');
    expect(ctx.body).toContain('not-redacted-here');
    expect(ctx.headers.get('x-req')).toBe('r1');
    expect(ctx.retried).toBe(false);
  });

  it('throws the Error it returns (a 404 that is really a dead credential)', async () => {
    const expired = new Error('HoneyBook auth expired — use use_magic_link');
    const fetchImpl = vi.fn(async () => json(404, { error_type: 'HBUnauthorizedError' }));
    const c = client(fetchImpl as unknown as typeof fetch, {
      onErrorResponse: (ctx) => (ctx.status === 404 && ctx.body.includes('HBUnauthorizedError') ? expired : undefined),
    });
    await expect(c.fetchJson('GET', '/x')).rejects.toBe(expired);
  });

  it('falls through to the default ApiError when it returns undefined — a plain 404 stays a 404', async () => {
    const fetchImpl = vi.fn(async () => json(404, { error: 'not found' }));
    const err = await client(fetchImpl as unknown as typeof fetch, { onErrorResponse: () => undefined })
      .fetchJson('GET', '/x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("re-sends the request ONCE on 'retry', re-reading baseHeaders (an API-version mismatch)", async () => {
    let version = 1;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(400, { error_type: 'HBWrongAPIVersionError', error_data: { server_api_version: 7 } }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const c = client(fetchImpl as unknown as typeof fetch, {
      baseHeaders: () => ({ 'hb-api-client-version': String(version) }),
      onErrorResponse: (ctx) => {
        if (!ctx.body.includes('HBWrongAPIVersionError')) return undefined;
        version = (JSON.parse(ctx.body) as { error_data: { server_api_version: number } }).error_data.server_api_version;
        return 'retry';
      },
    });
    await expect(c.fetchJson('POST', '/x', { body: { a: 1 } })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchImpl.mock.calls[0]!)['hb-api-client-version']).toBe('1');
    expect(headersOf(fetchImpl.mock.calls[1]!)['hb-api-client-version']).toBe('7');
    expect((fetchImpl.mock.calls[1]![1] as RequestInit).body).toBe('{"a":1}');
  });

  it("honours 'retry' only once per call; the second error response gets retried: true and then the default", async () => {
    const fetchImpl = vi.fn(async () => json(400, { error_type: 'HBWrongAPIVersionError' }));
    const flags: boolean[] = [];
    const err = await client(fetchImpl as unknown as typeof fetch, {
      onErrorResponse: (ctx) => {
        flags.push(ctx.retried);
        return 'retry';
      },
    })
      .fetchJson('GET', '/x')
      .catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(flags).toEqual([false, true]);
    expect(err).toBeInstanceOf(ApiError);
  });

  it('may be async', async () => {
    const fetchImpl = vi.fn(async () => json(409, {}));
    const mine = new Error('conflict');
    await expect(client(fetchImpl as unknown as typeof fetch, { onErrorResponse: async () => mine }).fetchJson('GET', '/x')).rejects.toBe(mine);
  });

  it('is not consulted for a CDN/WAF refusal page, which still throws EdgeBlockedError', async () => {
    const hook = vi.fn(() => new Error('should not be used'));
    const fetchImpl = vi.fn(
      async () => new Response('<html><title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    );
    await expect(client(fetchImpl as unknown as typeof fetch, { onErrorResponse: hook }).fetchJson('GET', '/x')).rejects.toBeInstanceOf(EdgeBlockedError);
    expect(hook).not.toHaveBeenCalled();
  });

  it('is not consulted for a 401 or a 429, which keep their own hooks', async () => {
    const hook = vi.fn(() => new Error('no'));
    const unauthorized = new Error('auth expired');
    const c = client(vi.fn(async () => json(401, {})) as unknown as typeof fetch, { onErrorResponse: hook, onUnauthorized: () => unauthorized });
    await expect(c.fetchJson('GET', '/x')).rejects.toBe(unauthorized);
    const limited = new Error('Rate limited by HoneyBook API');
    const c2 = client(vi.fn(async () => json(429, {})) as unknown as typeof fetch, { onErrorResponse: hook, onRateLimited: () => limited });
    await expect(c2.fetchJson('GET', '/x')).rejects.toBe(limited);
    expect(hook).not.toHaveBeenCalled();
  });

  it('is not consulted for a 2xx', async () => {
    const hook = vi.fn(() => new Error('no'));
    await expect(client(vi.fn(async () => json(200, { a: 1 })) as unknown as typeof fetch, { onErrorResponse: hook }).fetchJson('GET', '/x')).resolves.toEqual({ a: 1 });
    expect(hook).not.toHaveBeenCalled();
  });

  it('applies to fetchHtml and fetchRaw too', async () => {
    const mine = new Error('mine');
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const c = client(fetchImpl as unknown as typeof fetch, { onErrorResponse: (ctx) => (ctx.body === 'nope' ? mine : undefined) });
    await expect(c.fetchHtml('GET', '/x')).rejects.toBe(mine);
    await expect(c.fetchRaw('GET', '/x')).rejects.toBe(mine);
  });

  it('hands an over-cap error body over as empty, as the default error path does', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(100), { status: 500 }));
    await client(fetchImpl as unknown as typeof fetch, {
      maxResponseBytes: 10,
      onErrorResponse: (ctx) => {
        seen.push(ctx.body);
        return undefined;
      },
    })
      .fetchJson('GET', '/x')
      .catch(() => undefined);
    expect(seen).toEqual(['']);
  });
});

describe('idempotencyHeader', () => {
  it('sends one random id per logical call, the same on every attempt (429 retry and onErrorResponse retry)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}))
      .mockResolvedValueOnce(json(400, { error_type: 'HBWrongAPIVersionError' }))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    const c = client(fetchImpl as unknown as typeof fetch, {
      idempotencyHeader: 'hb-api-duplicate-calls-prevention-uuid',
      onErrorResponse: () => 'retry',
    });
    await c.fetchJson('POST', '/x', { body: {} });
    const ids = fetchImpl.mock.calls.map((call) => headersOf(call)['hb-api-duplicate-calls-prevention-uuid']);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(1);
  });

  it('uses a fresh id for each logical call', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const c = client(fetchImpl as unknown as typeof fetch, { idempotencyHeader: 'idempotency-key' });
    await c.fetchJson('POST', '/x');
    await c.fetchJson('POST', '/x');
    const [a, b] = fetchImpl.mock.calls.map((call) => headersOf(call)['idempotency-key']);
    expect(a).not.toBe(b);
  });

  it('takes a caller-supplied key, per call', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const c = client(fetchImpl as unknown as typeof fetch, { idempotencyHeader: 'idempotency-key' });
    await c.fetchRaw('POST', '/x', { idempotencyKey: 'mine-1' });
    expect(headersOf(fetchImpl.mock.calls[0]!)['idempotency-key']).toBe('mine-1');
  });

  it('a per-request header of the same name wins', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const c = client(fetchImpl as unknown as typeof fetch, { idempotencyHeader: 'Idempotency-Key' });
    await c.fetchHtml('POST', '/x', { headers: { 'idempotency-key': 'explicit' } });
    const h = headersOf(fetchImpl.mock.calls[0]!);
    expect(Object.entries(h).filter(([k]) => k.toLowerCase() === 'idempotency-key')).toEqual([['idempotency-key', 'explicit']]);
  });

  it('sends nothing when not configured', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await client(fetchImpl as unknown as typeof fetch).fetchJson('POST', '/x', { idempotencyKey: 'ignored' });
    expect(Object.keys(headersOf(fetchImpl.mock.calls[0]!)).map((k) => k.toLowerCase())).not.toContain('idempotency-key');
  });
});

describe('baseHeaders as a function', () => {
  it('is re-read on every request', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => json(200, {}));
    const c = client(fetchImpl as unknown as typeof fetch, { baseHeaders: () => ({ 'x-n': String(++n) }) });
    await c.fetchJson('GET', '/a');
    await c.fetchJson('GET', '/b');
    expect(fetchImpl.mock.calls.map((call) => headersOf(call)['x-n'])).toEqual(['1', '2']);
  });
});
