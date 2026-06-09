import { describe, it, expect, vi } from 'vitest';
import {
  createApiClient,
  buildQueryString,
  buildOptionalBody,
  formatApiError,
  parseLinkHeader,
  parseCookieJar,
  parseCookieHeader,
  CookieJar,
  ApiError,
  UpstreamHttpError,
  runBoundedBatch,
  decodeJwtExp,
  decodeJwtSessionId,
  validateJwtExpiry,
  UnauthorizedError,
  RateLimitedError,
  RequestTimeoutError,
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

  it('omits Authorization when neither getToken nor tokenManager is given', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://x.test', fetchImpl: fn });
    await client.fetchJson('GET', '/a');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('sends baseHeaders on every request, overridable per-request', async () => {
    const { fn, calls } = stubFetch([jsonResponse({}), jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn, baseHeaders: { 'x-api-version': '2026-05-01' } });
    await client.fetchJson('GET', '/a');
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-version']).toBe('2026-05-01');
    // a per-request header overrides a base header of the same name
    await client.fetchJson('GET', '/b', { headers: { 'x-api-version': 'override' } });
    expect((calls[1]!.init.headers as Record<string, string>)['x-api-version']).toBe('override');
  });

  it('routes auth through tokenManager.withAuth (and ignores getToken) when given', async () => {
    const { fn, calls } = stubFetch([jsonResponse({ ok: true })]);
    const getToken = vi.fn(() => 'GT');
    const withAuth = vi.fn((call: (t: string) => Promise<Response>) => call('TM-TOKEN'));
    const client = createApiClient({ baseUrl: 'https://x.test', getToken, fetchImpl: fn, tokenManager: { withAuth } });
    await client.fetchJson('GET', '/a');
    expect(withAuth).toHaveBeenCalledOnce();
    expect(getToken).not.toHaveBeenCalled();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer TM-TOKEN');
  });

  it('still applies the 429 retry around tokenManager mode', async () => {
    const { fn } = stubFetch([jsonResponse({}, 429), jsonResponse({ ok: true })]);
    const withAuth = vi.fn((call: (t: string) => Promise<Response>) => call('TM'));
    const sleep = vi.fn(async () => {});
    const client = createApiClient({ baseUrl: 'https://x.test', fetchImpl: fn, tokenManager: { withAuth }, sleep });
    await client.fetchJson('GET', '/a');
    expect(withAuth).toHaveBeenCalledTimes(2); // 429 → retry replays through withAuth
    expect(sleep).toHaveBeenCalledOnce();
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

describe('createApiClient timeout', () => {
  it('throws RequestTimeoutError when a request exceeds the timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          (e as { name: string }).name = 'AbortError';
          reject(e);
        });
      })) as unknown as typeof fetch;
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl, timeout: 5000 });

    const p = client.fetchJson('GET', '/a');
    const assertion = expect(p).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    vi.useRealTimers();
  });

  it('passes an AbortSignal to fetch when a timeout is set', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn, timeout: 5000 });
    await client.fetchJson('GET', '/a');
    expect((calls[0]!.init as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
  });

  it('sets no signal when no timeout is configured', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn });
    await client.fetchJson('GET', '/a');
    expect((calls[0]!.init as { signal?: unknown }).signal).toBeUndefined();
  });

  it('passes a non-abort fetch error through unchanged', async () => {
    const fetchImpl = (() => Promise.reject(new Error('network boom'))) as unknown as typeof fetch;
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl, timeout: 5000 });
    await expect(client.fetchJson('GET', '/a')).rejects.toThrow('network boom');
  });

  it('threads the AbortSignal through tokenManager.withAuth', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const withAuth = (call: (t: string) => Promise<Response>) => call('TM-TOKEN');
    const client = createApiClient({
      baseUrl: 'https://x.test',
      fetchImpl: fn,
      tokenManager: { withAuth },
      timeout: 5000,
    });
    await client.fetchJson('GET', '/a');
    expect((calls[0]!.init as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer TM-TOKEN');
  });
});

// --- parseCookieJar deletion detection (MU-B2) -------------------------------

describe('parseCookieJar deletion detection', () => {
  it('drops dash-format epoch Expires deletion markers (RFC-6265-era servers)', () => {
    const jar = parseCookieJar(['sess=gone; Expires=Thu, 01-Jan-1970 00:00:00 GMT', 'keep=yes']);
    expect(jar.cookies).toEqual({ keep: 'yes' });
  });

  it('drops negative Max-Age deletion markers', () => {
    const jar = parseCookieJar(['sess=gone; Max-Age=-1; Path=/', 'keep=yes']);
    expect(jar.cookies).toEqual({ keep: 'yes' });
  });

  it('drops any pre-2000 Expires, keeps a future Expires', () => {
    const jar = parseCookieJar([
      'old=x; Expires=Fri, 02 Jan 1970 00:00:00 GMT',
      'live=y; Expires=Wed, 21 Oct 2099 07:28:00 GMT',
    ]);
    expect(jar.cookies).toEqual({ live: 'y' });
  });

  it('keeps a cookie whose positive Max-Age outranks an epoch Expires (RFC 6265 precedence)', () => {
    const jar = parseCookieJar(['a=1; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    expect(jar.cookies).toEqual({ a: '1' });
  });

  it('keeps live cookies with a positive Max-Age or an unparseable Expires', () => {
    expect(parseCookieJar(['a=1; Max-Age=86400; Path=/']).cookies).toEqual({ a: '1' });
    expect(parseCookieJar(['a=1; Expires=banana']).cookies).toEqual({ a: '1' });
  });
});

// --- CookieJar (stateful) ----------------------------------------------------

describe('CookieJar', () => {
  it('absorbs an array of Set-Cookie strings; get/header/size', () => {
    const jar = new CookieJar();
    jar.absorb(['a=1; Path=/', 'b=2; HttpOnly']);
    expect(jar.get('a')).toBe('1');
    expect(jar.get('b')).toBe('2');
    expect(jar.get('missing')).toBeUndefined();
    expect(jar.header()).toBe('a=1; b=2');
    expect(jar.size).toBe(2);
  });

  it('later Set-Cookies override earlier ones by name, across absorbs', () => {
    const jar = new CookieJar();
    jar.absorb(['sess=first', 'sess=mid']);
    jar.absorb(['sess=last; Path=/']);
    expect(jar.get('sess')).toBe('last');
    expect(jar.size).toBe(1);
  });

  it('deletion cookies REMOVE the name from the jar', () => {
    const jar = new CookieJar();
    jar.absorb(['sess=abc; Path=/', 'other=1']);
    jar.absorb(['sess=; Max-Age=0']);
    expect(jar.get('sess')).toBeUndefined();
    expect(jar.header()).toBe('other=1');
    expect(jar.size).toBe(1);
  });

  it('removes on dash-format epoch Expires and negative Max-Age too', () => {
    const jar = new CookieJar();
    jar.absorb(['a=1', 'b=2']);
    jar.absorb(['a=gone; Expires=Thu, 01-Jan-1970 00:00:00 GMT', 'b=gone; Max-Age=-1']);
    expect(jar.size).toBe(0);
    expect(jar.header()).toBe('');
  });

  it('absorbs a Headers via getSetCookie() (canvas/skylight/signupgenius shape)', () => {
    const h = new Headers();
    h.append('set-cookie', 'canvas_session=tok; Path=/; HttpOnly');
    h.append('set-cookie', 'pseudonym_credentials=cred; Expires=Wed, 21 Oct 2099 07:28:00 GMT');
    const jar = new CookieJar();
    jar.absorb(h);
    expect(jar.get('canvas_session')).toBe('tok');
    expect(jar.header()).toBe('canvas_session=tok; pseudonym_credentials=cred');
  });

  it('falls back to a joined get("set-cookie") when getSetCookie is unavailable', () => {
    const jar = new CookieJar();
    jar.absorb({ get: (n: string) => (n === 'set-cookie' ? 'a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT, b=2' : null) });
    expect(jar.header()).toBe('a=1; b=2');
  });

  it('absorbs a single joined string, splitting safely around Expires commas', () => {
    const jar = new CookieJar();
    jar.absorb('a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT, b=2');
    expect(jar.get('a')).toBe('1');
    expect(jar.get('b')).toBe('2');
  });

  it('ignores empty-value cookies without deletion attributes (keeps the existing value)', () => {
    const jar = new CookieJar();
    jar.absorb(['a=1']);
    jar.absorb(['a=']);
    expect(jar.get('a')).toBe('1');
  });

  it('tolerates null/undefined/empty sources', () => {
    const jar = new CookieJar();
    jar.absorb(null);
    jar.absorb(undefined);
    jar.absorb([]);
    jar.absorb('');
    expect(jar.size).toBe(0);
    expect(jar.header()).toBe('');
  });
});

// --- ApiError ----------------------------------------------------------------

describe('createApiClient ApiError', () => {
  it('throws ApiError carrying status for non-2xx, message identical to formatApiError', async () => {
    const { fn } = stubFetch([new Response('missing', { status: 404 })]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', serviceName: 'X', fetchImpl: fn });
    const err = await client.fetchJson('GET', '/a').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect((err as ApiError).status).toBe(404);
    expect((err as Error).message).toBe(formatApiError(404, 'GET', '/a', 'missing', { service: 'X' }));
  });

  it('still redacts/truncates the upstream body in the ApiError message', async () => {
    const { fn } = stubFetch([new Response('Authorization: Bearer leak-me-secret-token', { status: 500 })]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', serviceName: 'X', fetchImpl: fn });
    const err = await client.fetchJson('get', '/a').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as Error).message).not.toContain('leak-me-secret-token');
  });

  it('fetchHtml also throws ApiError with status', async () => {
    const { fn } = stubFetch([new Response('nope', { status: 503 })]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn });
    const err = await client.fetchHtml('GET', '/p').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
  });
});

// --- retry statuses ------------------------------------------------------------

describe('createApiClient retry statuses', () => {
  it('retries the configured statuses (e.g. 5xx) then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = stubFetch([new Response('bad gateway', { status: 502 }), jsonResponse({ ok: 1 })]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => 't',
      fetchImpl: fn,
      sleep,
      retry: { count: 1, delayMs: 100, statuses: [429, 500, 502, 503, 504] },
    });
    expect(await client.fetchJson('GET', '/a')).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('an exhausted retried 5xx surfaces as ApiError (not RateLimitedError)', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = stubFetch([new Response('boom', { status: 502 })]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => 't',
      fetchImpl: fn,
      sleep,
      retry: { count: 1, delayMs: 0, statuses: [502] },
    });
    const err = await client.fetchJson('GET', '/a').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect(calls).toHaveLength(2);
  });

  it('does not retry statuses outside the default [429]', async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = stubFetch([new Response('boom', { status: 502 })]);
    const client = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl: fn, sleep });
    await client.fetchJson('GET', '/a').catch(() => {});
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a 429 exhausted under custom statuses still maps to RateLimitedError', async () => {
    const sleep = vi.fn(async () => {});
    const { fn } = stubFetch([new Response('slow', { status: 429 })]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => 't',
      fetchImpl: fn,
      sleep,
      retry: { count: 1, delayMs: 0, statuses: [429, 502] },
    });
    const err = await client.fetchJson('GET', '/a').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
  });
});

// --- tokenHeader -----------------------------------------------------------

describe('createApiClient tokenHeader', () => {
  it('sends the raw token in the named header (no Bearer prefix, no Authorization)', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => 'gk-123',
      tokenHeader: 'x-goog-api-key',
      fetchImpl: fn,
    });
    await client.fetchJson('GET', '/a');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('gk-123');
    expect(headers.Authorization).toBeUndefined();
  });

  it('sends neither header when the token resolves empty', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const client = createApiClient({
      baseUrl: 'https://x.test',
      getToken: () => undefined,
      tokenHeader: 'x-api-key',
      fetchImpl: fn,
    });
    await client.fetchJson('GET', '/a');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it('applies tokenHeader to tokenManager-supplied tokens too', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const withAuth = (call: (t: string) => Promise<Response>) => call('TM-TOKEN');
    const client = createApiClient({
      baseUrl: 'https://x.test',
      tokenManager: { withAuth },
      tokenHeader: 'x-auth-token',
      fetchImpl: fn,
    });
    await client.fetchJson('GET', '/a');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-auth-token']).toBe('TM-TOKEN');
    expect(headers.Authorization).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseCookieHeader
// ---------------------------------------------------------------------------

describe('parseCookieHeader', () => {
  it('parses a basic `name=value; name2=value2` header', () => {
    expect(parseCookieHeader('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('keeps `=` inside a value (only the first `=` splits)', () => {
    expect(parseCookieHeader('jwt=ab%3D%3D; sid=x=y=z')).toEqual({
      jwt: 'ab%3D%3D',
      sid: 'x=y=z',
    });
  });

  it('trims surrounding whitespace from names and values', () => {
    expect(parseCookieHeader('  a = 1 ;  b= 2 ')).toEqual({ a: '1', b: '2' });
  });

  it('skips pairs with a missing name (leading `=`)', () => {
    expect(parseCookieHeader('=oops; a=1')).toEqual({ a: '1' });
  });

  it('skips bare attribute fragments with no `=`', () => {
    expect(parseCookieHeader('a=1; HttpOnly; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('returns {} for an empty / whitespace header', () => {
    expect(parseCookieHeader('')).toEqual({});
    expect(parseCookieHeader('   ')).toEqual({});
  });

  it('keeps an empty value when the name is present (`a=`)', () => {
    expect(parseCookieHeader('a=; b=2')).toEqual({ a: '', b: '2' });
  });

  it('last value wins for a duplicate name', () => {
    expect(parseCookieHeader('a=1; a=2')).toEqual({ a: '2' });
  });

  it('matches extractCookieValue semantics for a single name lookup', () => {
    // creditkarma `extractCookieValue(cookieString, 'CKTRKID')` returns the
    // first/leading value; for a unique name our map yields the same value.
    const header = 'CKTRKID=abc123; other=zzz';
    expect(parseCookieHeader(header)['CKTRKID']).toBe('abc123');
  });
});

// ---------------------------------------------------------------------------
// UpstreamHttpError
// ---------------------------------------------------------------------------

describe('UpstreamHttpError', () => {
  it('carries the status and message and is directly constructible', () => {
    const err = new UpstreamHttpError(404, 'not found');
    expect(err.status).toBe(404);
    expect(err.message).toBe('not found');
    expect(err.name).toBe('UpstreamHttpError');
  });

  it('is an instance of ApiError and Error (so existing status-branch checks hold)', () => {
    const err = new UpstreamHttpError(503, 'down');
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UpstreamHttpError);
  });

  it('supports the 404-branch pattern via instanceof + status', () => {
    const branch = (err: unknown): string => {
      if (err instanceof UpstreamHttpError && err.status === 404) return 'fallback';
      throw err;
    };
    expect(branch(new UpstreamHttpError(404, 'x'))).toBe('fallback');
    expect(() => branch(new UpstreamHttpError(500, 'x'))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runBoundedBatch
// ---------------------------------------------------------------------------

describe('runBoundedBatch', () => {
  it('returns real results when everything settles before the deadline', async () => {
    const result = await runBoundedBatch([1, 2, 3], async (n) => n * 10, {
      deadlineMs: 1000,
      onTimeout: () => -1,
    });
    expect(result).toEqual([10, 20, 30]);
  });

  it('preserves input order regardless of completion order', async () => {
    const result = await runBoundedBatch([3, 1, 2], async (n) => {
      await Promise.resolve();
      return `v${n}`;
    }, {
      deadlineMs: 1000,
      onTimeout: () => 'pending',
    });
    expect(result).toEqual(['v3', 'v1', 'v2']);
  });

  it('backfills only the hung item via onTimeout, keeping the others real', async () => {
    let fireTimer: () => void = () => {};
    const fakeTimer = (_ms: number, cb: () => void): unknown => {
      fireTimer = cb;
      return 0 as unknown;
    };
    let releaseHung: () => void = () => {};

    const promise = runBoundedBatch(
      ['fast-a', 'hung', 'fast-b'],
      async (item) => {
        if (item === 'hung') {
          await new Promise<void>((r) => {
            releaseHung = r;
          });
          return 'hung-real';
        }
        return `${item}-ok`;
      },
      {
        deadlineMs: 45_000,
        onTimeout: (item, index) => `pending:${item}:${index}`,
        setTimer: fakeTimer as never,
        clearTimer: () => {},
      },
    );

    // Let the two fast workers settle, then trip the deadline.
    await Promise.resolve();
    await Promise.resolve();
    fireTimer();

    const result = await promise;
    expect(result).toEqual(['fast-a-ok', 'pending:hung:1', 'fast-b-ok']);
    releaseHung(); // the abandoned worker can settle harmlessly afterward
  });

  it('passes an abort signal to the worker when timing out', async () => {
    let fireTimer: () => void = () => {};
    const fakeTimer = (_ms: number, cb: () => void): unknown => {
      fireTimer = cb;
      return 0 as unknown;
    };
    let seenSignal: AbortSignal | undefined;
    const promise = runBoundedBatch(
      ['hung'],
      async (_item, signal) => {
        seenSignal = signal;
        await new Promise<void>(() => {}); // never settles
        return 'unreachable';
      },
      {
        deadlineMs: 10,
        onTimeout: () => 'pending',
        setTimer: fakeTimer as never,
        clearTimer: () => {},
      },
    );
    await Promise.resolve();
    fireTimer();
    const result = await promise;
    expect(result).toEqual(['pending']);
    expect(seenSignal?.aborted).toBe(true);
  });

  it('honors the concurrency cap (never more than N workers in flight)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await runBoundedBatch(
      [1, 2, 3, 4, 5],
      async (n) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return n;
      },
      { deadlineMs: 1000, onTimeout: () => -1, concurrency: 2 },
    );
    expect(result).toEqual([1, 2, 3, 4, 5]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('returns [] for an empty item list without arming a timer', () => {
    let armed = false;
    const out = runBoundedBatch([], async (n) => n, {
      deadlineMs: 1000,
      onTimeout: () => -1,
      setTimer: (() => {
        armed = true;
        return 0;
      }) as never,
      clearTimer: () => {},
    });
    return out.then((r) => {
      expect(r).toEqual([]);
      expect(armed).toBe(false);
    });
  });

  it('isolates a worker rejection to its slot — others complete, batch does not reject', async () => {
    const result = await runBoundedBatch(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('boom');
        return n * 10;
      },
      { deadlineMs: 1000, onTimeout: (item) => `timeout:${item}` as unknown as number },
    );
    // The throwing item falls back to onTimeout (default); the rest succeed.
    expect(result).toEqual([10, 'timeout:2', 30]);
  });

  it('routes a worker rejection through onError when provided (distinct from a timeout)', async () => {
    const result = await runBoundedBatch(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('boom');
        return n * 10;
      },
      {
        deadlineMs: 1000,
        onTimeout: (item) => `timeout:${item}` as unknown as number,
        onError: (item, _i, err) => `error:${item}:${(err as Error).message}` as unknown as number,
      },
    );
    expect(result).toEqual([10, 'error:2:boom', 30]);
  });

  it('a worker rejection under a concurrency cap does not strand queued items', async () => {
    // limit=1 so all items share one runner; the throw on item 2 must not stop
    // it from reaching item 3.
    const seen: number[] = [];
    const result = await runBoundedBatch(
      [1, 2, 3],
      async (n) => {
        seen.push(n);
        if (n === 2) throw new Error('boom');
        return n;
      },
      { deadlineMs: 1000, concurrency: 1, onTimeout: () => -1 },
    );
    expect(seen).toEqual([1, 2, 3]); // item 3 still ran
    expect(result).toEqual([1, -1, 3]);
  });
});
