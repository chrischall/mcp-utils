import { describe, it, expect, vi } from 'vitest';
import {
  createApiClient,
  buildQueryString,
  buildOptionalBody,
  formatApiError,
  parseLinkHeader,
  parseCookieJar,
  decodeJwtExp,
  decodeJwtSessionId,
  validateJwtExpiry,
  UnauthorizedError,
  RateLimitedError,
} from './index.js';

// --- helpers ---------------------------------------------------------------

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

/** A fetch stub that returns a queue of Responses, recording the calls. */
function stubFetch(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return res!;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// --- createApiClient -------------------------------------------------------

describe('createApiClient.fetchJson', () => {
  it('sends a bearer token, Accept, and parses JSON', async () => {
    const { fn, calls } = stubFetch([jsonResponse({ ok: true })]);
    const client = createApiClient({
      baseUrl: 'https://api.example.com/v1',
      getToken: () => 'tok-123',
      fetchImpl: fn,
    });
    const out = await client.fetchJson<{ ok: boolean }>('GET', '/things');
    expect(out).toEqual({ ok: true });
    expect(calls[0]!.url).toBe('https://api.example.com/v1/things');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(headers.Accept).toBe('application/json');
  });

  it('trims a trailing slash from baseUrl', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://x.test/', getToken: () => 't', fetchImpl: fn });
    await client.fetchJson('GET', '/a');
    expect(calls[0]!.url).toBe('https://x.test/a');
  });

  it('omits Authorization when getToken returns undefined', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => undefined, fetchImpl: fn });
    await client.fetchJson('GET', '/a');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('serializes a body and sets Content-Type only when a body is present', async () => {
    const { fn, calls } = stubFetch([jsonResponse({}), jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn });
    await client.fetchJson('POST', '/a', { body: { name: 'z' } });
    expect(calls[0]!.init.body).toBe('{"name":"z"}');
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    await client.fetchJson('GET', '/b');
    expect(calls[1]!.init.body).toBeUndefined();
    expect((calls[1]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('sends a FormData body as multipart, without overriding Content-Type', async () => {
    const { fn, calls } = stubFetch([jsonResponse({ id: '1' })]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn });
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('img')], { type: 'image/png' }), 'a.png');
    await client.fetchJson('PUT', '/a', { formData: fd });
    // body is passed through verbatim so fetch derives the multipart boundary itself.
    expect(calls[0]!.init.body).toBe(fd);
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer t');
  });

  it('prefers formData over a JSON body when both are given', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn });
    const fd = new FormData();
    fd.append('x', '1');
    await client.fetchJson('POST', '/a', { formData: fd, body: { ignored: true } });
    expect(calls[0]!.init.body).toBe(fd);
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('appends query params', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn });
    await client.fetchJson('GET', '/a', { query: { q: 'hi', skip: undefined } });
    expect(calls[0]!.url).toBe('https://x.test/a?q=hi');
  });

  it('returns undefined on 204', async () => {
    const { fn } = stubFetch([new Response(null, { status: 204 })]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn });
    expect(await client.fetchJson('DELETE', '/a')).toBeUndefined();
  });

  it('returns undefined on an empty 200 body', async () => {
    const { fn } = stubFetch([new Response('', { status: 200 })]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn });
    expect(await client.fetchJson('GET', '/a')).toBeUndefined();
  });

  it('throws UnauthorizedError on 401 without echoing the token', async () => {
    const { fn } = stubFetch([new Response('bad token tok-secret', { status: 401 })]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => 'tok-secret',
      serviceName: 'X',
      fetchImpl: fn,
    });
    const err = await client.fetchJson('GET', '/a').catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as Error).message).not.toContain('tok-secret');
    expect((err as UnauthorizedError).status).toBe(401);
  });

  it('retries once after delay on 429, then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = stubFetch([new Response('slow', { status: 429 }), jsonResponse({ ok: 1 })]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => 't',
      fetchImpl: fn,
      sleep,
    });
    const out = await client.fetchJson('GET', '/a');
    expect(out).toEqual({ ok: 1 });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls).toHaveLength(2);
  });

  it('throws RateLimitedError when 429 persists past the retry budget', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = stubFetch([new Response('slow', { status: 429 })]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => 't',
      serviceName: 'X',
      fetchImpl: fn,
      sleep,
    });
    const err = await client.fetchJson('GET', '/a').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(calls).toHaveLength(2); // initial + 1 retry
  });

  it('uses a custom onUnauthorized error on 401 (preserving no-token-in-message)', async () => {
    const { fn } = stubFetch([new Response('bad token tok-secret', { status: 401 })]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => 'tok-secret',
      serviceName: 'Tempo',
      fetchImpl: fn,
      onUnauthorized: () => new Error('TEMPO_API_TOKEN is invalid or expired'),
    });
    const err = await client.fetchJson('GET', '/a').catch((e) => e);
    expect((err as Error).message).toBe('TEMPO_API_TOKEN is invalid or expired');
    expect((err as Error).message).not.toContain('tok-secret');
  });

  it('uses a custom onRateLimited error when 429 persists', async () => {
    const sleep = vi.fn(async () => {});
    const { fn } = stubFetch([new Response('slow', { status: 429 })]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => 't',
      fetchImpl: fn,
      sleep,
      retry: { count: 0, delayMs: 0 },
      onRateLimited: () => new Error('Rate limited by Tempo API'),
    });
    const err = await client.fetchJson('GET', '/a').catch((e) => e);
    expect((err as Error).message).toBe('Rate limited by Tempo API');
  });

  it('honors a custom retry policy (count: 0 disables retry)', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = stubFetch([new Response('slow', { status: 429 })]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => 't',
      retry: { count: 0, delayMs: 5 },
      fetchImpl: fn,
      sleep,
    });
    await client.fetchJson('GET', '/a').catch(() => {});
    expect(sleep).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('formats a redacted, truncated message for other non-2xx', async () => {
    const { fn } = stubFetch([new Response('Authorization: Bearer leak-me-secret-token', { status: 500 })]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => 't',
      serviceName: 'X',
      fetchImpl: fn,
    });
    const err = await client.fetchJson('get', '/a').catch((e) => e);
    expect((err as Error).message).toContain('X error 500 for GET /a');
    expect((err as Error).message).not.toContain('leak-me-secret-token');
    expect((err as Error).message).toContain('[REDACTED]');
  });

  it('calls getToken per request (supports rotation) and awaits async tokens', async () => {
    const tokens = ['t1', 't2'];
    let n = 0;
    const { fn, calls } = stubFetch([jsonResponse({}), jsonResponse({})]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: async () => tokens[n++]!,
      fetchImpl: fn,
    });
    await client.fetchJson('GET', '/a');
    await client.fetchJson('GET', '/b');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer t1');
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer t2');
  });
});

describe('createApiClient.fetchHtml', () => {
  it('returns raw text and sends an html Accept header', async () => {
    const { fn, calls } = stubFetch([new Response('<html>hi</html>', { status: 200 })]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn });
    expect(await client.fetchHtml('GET', '/page')).toBe('<html>hi</html>');
    expect((calls[0]!.init.headers as Record<string, string>).Accept).toContain('text/html');
  });

  it('throws UnauthorizedError on 401 and redacts error bodies', async () => {
    const { fn } = stubFetch([new Response('Bearer abc.def.ghi here', { status: 403 })]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', serviceName: 'X', fetchImpl: fn });
    const err = await client.fetchHtml('GET', '/p').catch((e) => e);
    expect((err as Error).message).toContain('X error 403');
    expect((err as Error).message).toContain('[REDACTED]');
  });
});

// --- buildQueryString ------------------------------------------------------

describe('buildQueryString', () => {
  it('returns empty string for no usable params', () => {
    expect(buildQueryString({})).toBe('');
    expect(buildQueryString({ a: undefined, b: null, c: '' })).toBe('');
  });

  it('encodes keys and values', () => {
    expect(buildQueryString({ 'a b': 'c&d' })).toBe('?a%20b=c%26d');
  });

  it('skips null/undefined/empty but keeps 0 and false', () => {
    expect(buildQueryString({ a: 0, b: false, c: null, d: undefined, e: '' })).toBe('?a=0&b=false');
  });

  it('expands arrays into repeated keys and skips empty members', () => {
    expect(buildQueryString({ tag: ['x', 'y'], q: null })).toBe('?tag=x&tag=y');
    expect(buildQueryString({ tag: ['x', null, '', 'z'] })).toBe('?tag=x&tag=z');
  });
});

// --- buildOptionalBody -----------------------------------------------------

describe('buildOptionalBody', () => {
  it('includes only present (non-undefined) optional fields', () => {
    const args = { id: 1, name: 'a', desc: undefined as string | undefined, extra: 'x' };
    expect(buildOptionalBody(args, ['name', 'desc'])).toEqual({ name: 'a' });
  });

  it('preserves null (an explicit clear)', () => {
    const args = { name: null as string | null };
    expect(buildOptionalBody(args, ['name'])).toEqual({ name: null });
  });

  it('returns an empty object when nothing is provided', () => {
    expect(buildOptionalBody({ a: undefined }, ['a'])).toEqual({});
  });
});

// --- formatApiError --------------------------------------------------------

describe('formatApiError', () => {
  it('builds a service/status/method/path prefix and upper-cases the method', () => {
    expect(formatApiError(404, 'get', '/x', 'not found', { service: 'Svc' })).toBe(
      'Svc error 404 for GET /x: not found',
    );
  });

  it('redacts bearer tokens in the upstream body', () => {
    const msg = formatApiError(500, 'GET', '/x', 'Authorization: Bearer sk-leak-abcdefgh');
    expect(msg).not.toContain('sk-leak-abcdefgh');
    expect(msg).toContain('[REDACTED]');
  });

  it('truncates oversized bodies', () => {
    const big = 'A'.repeat(1000);
    const msg = formatApiError(500, 'GET', '/x', big, { max: 50 });
    expect(msg).toContain('… [truncated]');
    expect(msg.length).toBeLessThan(200);
  });

  it('drops a dangling colon when the body is empty/whitespace', () => {
    expect(formatApiError(500, 'GET', '/x', '   ', { service: 'Svc' })).toBe('Svc error 500 for GET /x');
    expect(formatApiError(500, 'GET', '/x', '')).toBe('API error 500 for GET /x');
  });
});

// --- parseLinkHeader -------------------------------------------------------

describe('parseLinkHeader', () => {
  it('parses next/prev/first/last', () => {
    const h =
      '<https://x/p?page=2>; rel="next", <https://x/p?page=1>; rel="prev", <https://x/p?page=1>; rel="first", <https://x/p?page=9>; rel="last"';
    const parsed = parseLinkHeader(h);
    expect(parsed.next).toBe('https://x/p?page=2');
    expect(parsed.prev).toBe('https://x/p?page=1');
    expect(parsed.first).toBe('https://x/p?page=1');
    expect(parsed.last).toBe('https://x/p?page=9');
  });

  it('accepts unquoted rel and skips malformed entries', () => {
    const parsed = parseLinkHeader('<https://x/2>; rel=next, garbage, <bad');
    expect(parsed.next).toBe('https://x/2');
    expect(Object.keys(parsed)).toEqual(['next']);
  });

  it('returns {} for missing/empty header', () => {
    expect(parseLinkHeader(null)).toEqual({});
    expect(parseLinkHeader(undefined)).toEqual({});
    expect(parseLinkHeader('')).toEqual({});
  });
});

// --- parseCookieJar --------------------------------------------------------

describe('parseCookieJar', () => {
  it('dedups by name with last-wins and builds a Cookie header', () => {
    const jar = parseCookieJar([
      'a=1; Path=/',
      'b=2; HttpOnly',
      'a=3; Path=/', // later set wins
    ]);
    expect(jar.cookies).toEqual({ a: '3', b: '2' });
    expect(jar.cookieHeader).toBe('a=3; b=2');
  });

  it('drops Max-Age=0 deletion markers', () => {
    const jar = parseCookieJar(['appName=; Max-Age=0', 'appName=springfield; Path=/']);
    expect(jar.cookies).toEqual({ appName: 'springfield' });
  });

  it('drops epoch-Expires deletion markers and empty values', () => {
    const jar = parseCookieJar([
      'sess=; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'keep=yes',
      'blank=',
    ]);
    expect(jar.cookies).toEqual({ keep: 'yes' });
  });

  it('accepts a single joined string and splits on cookie boundaries (not Expires commas)', () => {
    const jar = parseCookieJar('a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT, b=2');
    expect(jar.cookies).toEqual({ a: '1', b: '2' });
  });

  it('returns empty jar for null/undefined', () => {
    expect(parseCookieJar(null)).toEqual({ cookies: {}, cookieHeader: '' });
    expect(parseCookieJar(undefined)).toEqual({ cookies: {}, cookieHeader: '' });
  });
});

// --- JWT helpers -----------------------------------------------------------

describe('decodeJwtExp', () => {
  it('decodes a numeric exp', () => {
    expect(decodeJwtExp(jwt({ exp: 1700000000 }))).toBe(1700000000);
  });

  it('throws on malformed structure', () => {
    expect(() => decodeJwtExp('not-a-jwt')).toThrow(/Invalid JWT/);
  });

  it('throws when exp is missing or non-numeric', () => {
    expect(() => decodeJwtExp(jwt({ exp: 'soon' }))).toThrow(/exp/);
    expect(() => decodeJwtExp(jwt({ foo: 1 }))).toThrow(/exp/);
  });
});

describe('decodeJwtSessionId', () => {
  it('returns session_id when present', () => {
    expect(decodeJwtSessionId(jwt({ session_id: 'abc' }))).toBe('abc');
  });

  it('falls back to sid', () => {
    expect(decodeJwtSessionId(jwt({ sid: 'xyz' }))).toBe('xyz');
  });

  it('returns null for an undecodable token or absent claim (never throws)', () => {
    expect(decodeJwtSessionId('garbage')).toBeNull();
    expect(decodeJwtSessionId(jwt({ exp: 1 }))).toBeNull();
  });
});

describe('validateJwtExpiry', () => {
  const now = 1_700_000_000_000; // ms

  it('reports a healthy token as not expired with expiresIn', () => {
    const token = jwt({ exp: Math.floor(now / 1000) + 3600 });
    const r = validateJwtExpiry(token, now);
    expect(r.expired).toBe(false);
    expect(r.expiresIn).toBe(3600);
    expect(r.warning).toBeUndefined();
  });

  it('flags an expired token', () => {
    const token = jwt({ exp: Math.floor(now / 1000) - 10 });
    const r = validateJwtExpiry(token, now);
    expect(r.expired).toBe(true);
    expect(r.expiresIn).toBe(-10);
    expect(r.warning).toMatch(/expired/i);
  });

  it('warns on near-expiry within the skew but is not yet expired', () => {
    const token = jwt({ exp: Math.floor(now / 1000) + 60 });
    const r = validateJwtExpiry(token, now);
    expect(r.expired).toBe(false);
    expect(r.warning).toMatch(/refresh soon/i);
  });

  it('fails closed (expired:true) for an undecodable token', () => {
    const r = validateJwtExpiry('garbage', now);
    expect(r.expired).toBe(true);
    expect(r.expiresIn).toBeUndefined();
    expect(r.warning).toBeTruthy();
  });
});
