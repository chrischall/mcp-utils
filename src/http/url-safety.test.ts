import { describe, it, expect, vi } from 'vitest';
import {
  createApiClient,
  apiPath,
  readOriginEnv,
  assertAllowedUrl,
  UrlNotAllowedError,
  RedirectRefusedError,
  findPathHazard,
} from './index.js';

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
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function redirect(location: string | undefined, status = 302): Response {
  return new Response(null, { status, headers: location === undefined ? {} : { location } });
}

// --- cluster 5: dot segments ------------------------------------------------

describe('findPathHazard', () => {
  it('names tab, LF and CR in the path as a control character', () => {
    expect(findPathHazard('/a/.\t./b')).toBe('control character');
    expect(findPathHazard('/a/%2e\n%2e/b')).toBe('control character');
    expect(findPathHazard('/a\r')).toBe('control character');
  });
  it('does not judge control characters in the query', () => {
    expect(findPathHazard('/a?q=x\ty')).toBeUndefined();
  });
  it('names any C0 control character or DEL in the path as a control character', () => {
    expect(findPathHazard('/a/..\x00')).toBe('control character');
    expect(findPathHazard('/a/.\x1f')).toBe('control character');
    expect(findPathHazard('/a/b\x7fc')).toBe('control character');
  });
  it('names a path part ending in a space as a trailing space', () => {
    expect(findPathHazard('/a/.. ')).toBe('trailing space');
    expect(findPathHazard('/a/%2e%2e ')).toBe('trailing space');
    expect(findPathHazard('/a/.. ?q=1')).toBe('trailing space');
  });
  it('leaves an interior space and a space in the query alone', () => {
    expect(findPathHazard('/a/b c/d')).toBeUndefined();
    expect(findPathHazard('/a?q=x ')).toBeUndefined();
  });
});

describe('createApiClient refuses a path that URL normalisation would rewrite', () => {
  const bad = [
    '/trails/../admin',
    '/trails/..',
    '/../x',
    '/a/./b',
    '/a/.',
    '/a/%2e%2e/b',
    '/a/%2E%2e/b',
    '/a/.%2e/b',
    '/a/%2e./b',
    '/a/%2e/b',
    '/a\\..\\b',
    '/a\\b',
    '/a/..?q=1',
    '/a/..#frag',
    // WHATWG URL parsing deletes ASCII tab/LF/CR before resolving dot segments.
    '/trails/.\t./admin',
    '/trails/%2e\n%2e/admin',
    '/trails/.\r./x',
    '/a/b\tc',
    // ...and strips trailing C0 controls and spaces from the whole URL first.
    '/trails/x/.. ',
    '/trails/x/..\x00',
    '/trails/x/..\x1f',
    '/trails/x/%2e%2e ',
    '/trails/x/%2e%2e\x00',
    '/trails/x/%2e%2e\x1f',
    '/trails/x/.\x1f',
    '/trails/x/.. \x00 ',
  ];
  for (const path of bad) {
    it(`refuses ${JSON.stringify(path)} before any fetch`, async () => {
      const { fn, calls } = stubFetch([jsonResponse({})]);
      const client = createApiClient({ baseUrl: 'https://api.example.com/v1', getToken: () => 'SECRET', fetchImpl: fn });
      await expect(client.fetchJson('GET', path)).rejects.toThrow(/dot segment|backslash|control character|trailing space/i);
      await expect(client.fetchHtml('GET', path)).rejects.toThrow(/dot segment|backslash|control character|trailing space/i);
      await expect(client.fetchRaw('GET', path)).rejects.toThrow(/dot segment|backslash|control character|trailing space/i);
      expect(calls).toHaveLength(0);
    });
  }

  it('quotes only the path part, never the query, in the refusal', async () => {
    const { fn } = stubFetch([jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://api.example.com/v1', fetchImpl: fn });
    const err = await client.fetchJson('GET', '/a/../b?token=SECRETQ').catch((e: unknown) => e as Error);
    expect(err.message).toContain('"/a/../b"');
    expect(err.message).not.toContain('SECRETQ');
  });

  it('leaves dots that are not whole segments, and dots or backslashes in the query, alone', async () => {
    const { fn, calls } = stubFetch([jsonResponse({}), jsonResponse({}), jsonResponse({}), jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://api.example.com/v1', getToken: () => 't', fetchImpl: fn });
    await client.fetchJson('GET', '/files/a.b/...');
    await client.fetchJson('GET', '/files/.hidden/x..y');
    await client.fetchJson('GET', '/search?q=../x&p=a\\b');
    await client.fetchJson('GET', '/a', { query: { path: '../..' } });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example.com/v1/files/a.b/...',
      'https://api.example.com/v1/files/.hidden/x..y',
      'https://api.example.com/v1/search?q=../x&p=a\\b',
      'https://api.example.com/v1/a?path=..%2F..',
    ]);
  });

  it('does not judge dot segments in the baseUrl itself', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://api.example.com/v1/./x', fetchImpl: fn });
    await client.fetchJson('GET', '/y');
    expect(calls).toHaveLength(1);
  });
});

describe('apiPath', () => {
  it('encodes each interpolated value as one segment', () => {
    expect(apiPath`/trails/${'a b/c?d#e'}/reviews`).toBe('/trails/a%20b%2Fc%3Fd%23e/reviews');
    expect(apiPath`/users/${42}/x/${10n}`).toBe('/users/42/x/10');
    expect(apiPath`/static`).toBe('/static');
  });

  it('encodes a backslash and percent so they cannot be decoded into structure', () => {
    expect(apiPath`/f/${'a\\b'}/${'%2e%2e'}`).toBe('/f/a%5Cb/%252e%252e');
  });

  for (const v of ['.', '..', '']) {
    it(`throws on the value ${JSON.stringify(v)}`, () => {
      expect(() => apiPath`/trails/${v}/reviews`).toThrow(TypeError);
      expect(() => apiPath`/trails/${v}/reviews`).toThrow(/apiPath/);
    });
  }

  it('refuses a non-string, non-number value', () => {
    expect(() => apiPath`/a/${undefined as unknown as string}`).toThrow(TypeError);
    expect(() => apiPath`/a/${{} as unknown as string}`).toThrow(TypeError);
    expect(() => apiPath`/a/${Number.NaN}`).toThrow(TypeError);
  });

  it('round-trips through createApiClient unchanged', async () => {
    const { fn, calls } = stubFetch([jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fn });
    await client.fetchJson('GET', apiPath`/trails/${'../admin'}`);
    expect(calls[0]!.url).toBe('https://api.example.com/trails/..%2Fadmin');
  });
});

// --- cluster 6: env origins and user-supplied links -------------------------

describe('readOriginEnv', () => {
  const env = (v: string | undefined) => ({ BASE: v });

  it('returns the origin of an https URL or a bare host', () => {
    expect(readOriginEnv('BASE', { env: env('https://API.example.com/') })).toBe('https://api.example.com');
    expect(readOriginEnv('BASE', { env: env('api.example.com') })).toBe('https://api.example.com');
    expect(readOriginEnv('BASE', { env: env('api.example.com:8443') })).toBe('https://api.example.com:8443');
    expect(readOriginEnv('BASE', { env: env('  https://api.example.com  ') })).toBe('https://api.example.com');
  });

  it('returns the default (or undefined) when unset or a placeholder', () => {
    expect(readOriginEnv('BASE', { env: env(undefined) })).toBeUndefined();
    expect(readOriginEnv('BASE', { env: env('${BASE}'), default: 'https://d.example.com' })).toBe(
      'https://d.example.com',
    );
  });

  const refused: Array<[string, RegExp]> = [
    ['http://api.example.com', /https/],
    ['ftp://api.example.com', /http/],
    ['javascript:alert(1)', /http/],
    ['https://https://api.example.com', /origin/],
    ['https://api.example.com/v1', /origin/],
    ['https://api.example.com?x=1', /origin/],
    ['https://api.example.com#x', /origin/],
    ['https://user:SECRETPW@api.example.com', /credentials|userinfo/],
    ['not a host', /valid/],
  ];
  for (const [value, re] of refused) {
    it(`refuses ${JSON.stringify(value)} without echoing the value`, () => {
      let err: unknown;
      try {
        readOriginEnv('BASE', { env: env(value) });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UrlNotAllowedError);
      const msg = (err as Error).message;
      expect(msg).toMatch(re);
      expect(msg).toContain('BASE');
      expect(msg).not.toContain('SECRETPW');
      expect(msg).not.toContain(value);
    });
  }

  it('enforces allowHosts, exact or by *. suffix or RegExp', () => {
    const allowHosts = ['api.example.com', '*.example.org', /^eu\d\.example\.net$/];
    expect(readOriginEnv('BASE', { env: env('api.example.com'), allowHosts })).toBe('https://api.example.com');
    expect(readOriginEnv('BASE', { env: env('a.b.example.org'), allowHosts })).toBe('https://a.b.example.org');
    expect(readOriginEnv('BASE', { env: env('eu2.example.net'), allowHosts })).toBe('https://eu2.example.net');
    expect(() => readOriginEnv('BASE', { env: env('example.org'), allowHosts })).toThrow(/allowed/);
    expect(() => readOriginEnv('BASE', { env: env('evil.test'), allowHosts })).toThrow(/allowed/);
    expect(() => readOriginEnv('BASE', { env: env('api.example.com.evil.test'), allowHosts })).toThrow(/allowed/);
  });

  it('checks the default against the same rules', () => {
    expect(() => readOriginEnv('BASE', { env: env(undefined), default: 'http://x.example.com' })).toThrow(/https/);
  });

  it('allows http for loopback only with allowHttpLoopback, and anywhere with requireHttps: false', () => {
    expect(readOriginEnv('BASE', { env: env('http://localhost:8080'), allowHttpLoopback: true })).toBe(
      'http://localhost:8080',
    );
    expect(readOriginEnv('BASE', { env: env('http://127.0.0.1:9'), allowHttpLoopback: true })).toBe('http://127.0.0.1:9');
    expect(readOriginEnv('BASE', { env: env('http://[::1]:9'), allowHttpLoopback: true })).toBe('http://[::1]:9');
    expect(() => readOriginEnv('BASE', { env: env('http://evil.test'), allowHttpLoopback: true })).toThrow(/https/);
    expect(readOriginEnv('BASE', { env: env('http://intranet.local'), requireHttps: false })).toBe('http://intranet.local');
  });

  it('reads process.env by default', () => {
    process.env.MCP_UTILS_TEST_ORIGIN = 'api.example.com';
    try {
      expect(readOriginEnv('MCP_UTILS_TEST_ORIGIN')).toBe('https://api.example.com');
    } finally {
      delete process.env.MCP_UTILS_TEST_ORIGIN;
    }
  });
});

describe('assertAllowedUrl', () => {
  const allowHosts = ['www.thumbtack.com', '*.accesso.com'];

  it('returns the parsed URL when scheme and host are allowed', () => {
    const u = assertAllowedUrl('https://www.thumbtack.com/pro/1?x=2', { allowHosts });
    expect(u).toBeInstanceOf(URL);
    expect(u.pathname).toBe('/pro/1');
    expect(assertAllowedUrl(new URL('https://m.accesso.com/t'), { allowHosts }).host).toBe('m.accesso.com');
  });

  const refused: Array<[string, RegExp]> = [
    ['http://www.thumbtack.com/x', /https/],
    ['javascript:alert(1)', /http/],
    ['file:///etc/passwd', /http/],
    ['https://evil.test/x', /allowed/],
    ['https://www.thumbtack.com.evil.test/x', /allowed/],
    ['https://user:pw@www.thumbtack.com/x', /credentials|userinfo/],
    ['::not a url', /valid/],
  ];
  for (const [url, re] of refused) {
    it(`refuses ${JSON.stringify(url)}`, () => {
      expect(() => assertAllowedUrl(url, { allowHosts })).toThrow(UrlNotAllowedError);
      expect(() => assertAllowedUrl(url, { allowHosts })).toThrow(re);
    });
  }

  it('never echoes the path or query, which may carry a token', () => {
    try {
      assertAllowedUrl('https://evil.test/x?token=SECRET', { allowHosts });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET');
      expect((e as Error).message).toContain('evil.test');
    }
  });

  it('allows http when requireHttps is false, or for loopback with allowHttpLoopback', () => {
    expect(assertAllowedUrl('http://www.thumbtack.com/x', { allowHosts, requireHttps: false }).protocol).toBe('http:');
    expect(
      assertAllowedUrl('http://localhost:3000/x', { allowHosts: ['localhost'], allowHttpLoopback: true }).port,
    ).toBe('3000');
  });

  it('requires a non-empty allowHosts', () => {
    expect(() => assertAllowedUrl('https://www.thumbtack.com', { allowHosts: [] })).toThrow(TypeError);
  });
});

// --- cluster 6: redirects ---------------------------------------------------

describe("createApiClient redirect: 'same-origin'", () => {
  it('follows a same-origin redirect manually, re-sending the credential', async () => {
    const { fn, calls } = stubFetch([redirect('/v1/moved?x=1', 301), jsonResponse({ ok: true })]);
    const client = createApiClient({
      baseUrl: 'https://api.example.com/v1',
      getToken: () => 'TOKEN',
      fetchImpl: fn,
      redirect: 'same-origin',
    });
    await expect(client.fetchJson('GET', '/old')).resolves.toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual(['https://api.example.com/v1/old', 'https://api.example.com/v1/moved?x=1']);
    expect(calls.every((c) => c.init.redirect === 'manual')).toBe(true);
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN');
  });

  it('refuses a hop to another origin without sending anything there', async () => {
    const { fn, calls } = stubFetch([redirect('https://evil.test/steal?t=SECRET'), jsonResponse({})]);
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'TOKEN',
      fetchImpl: fn,
      redirect: 'same-origin',
    });
    const err = await client.fetchJson('GET', '/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect((err as Error).message).toContain('https://evil.test');
    expect((err as Error).message).not.toContain('SECRET');
    expect(calls).toHaveLength(1);
  });

  it('refuses a scheme downgrade on the same host', async () => {
    const { fn, calls } = stubFetch([redirect('http://api.example.com/x'), jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fn, redirect: 'same-origin' });
    await expect(client.fetchHtml('GET', '/x')).rejects.toBeInstanceOf(RedirectRefusedError);
    expect(calls).toHaveLength(1);
  });

  it('refuses a hop that introduces userinfo', async () => {
    const { fn } = stubFetch([redirect('https://u:p@api.example.com/x'), jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fn, redirect: 'same-origin' });
    await expect(client.fetchRaw('GET', '/x')).rejects.toBeInstanceOf(RedirectRefusedError);
  });

  it('refuses an unparseable Location', async () => {
    const { fn, calls } = stubFetch([redirect('http://[bad'), jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fn, redirect: 'same-origin' });
    await expect(client.fetchJson('GET', '/x')).rejects.toThrow(/not a valid URL/);
    expect(calls).toHaveLength(1);
  });

  for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
    it(`rejects maxRedirects ${bad} at construction`, () => {
      expect(() =>
        createApiClient({ baseUrl: 'https://api.example.com', redirect: 'same-origin', maxRedirects: bad }),
      ).toThrow(TypeError);
    });
  }

  it('accepts maxRedirects 0 (refuses the first hop)', async () => {
    const { fn, calls } = stubFetch([redirect('/a'), jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fn, redirect: 'same-origin', maxRedirects: 0 });
    await expect(client.fetchJson('GET', '/x')).rejects.toThrow(/too many redirects/i);
    expect(calls).toHaveLength(1);
  });

  it('stops after maxRedirects hops', async () => {
    const { fn, calls } = stubFetch([redirect('/loop')]);
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      fetchImpl: fn,
      redirect: 'same-origin',
      maxRedirects: 3,
    });
    await expect(client.fetchJson('GET', '/loop')).rejects.toThrow(/too many redirects/i);
    expect(calls).toHaveLength(4);
  });

  it('turns a 303 (and a 302 after POST) into a body-less GET, and keeps method and body on 307/308', async () => {
    const { fn, calls } = stubFetch([
      redirect('/a', 303),
      jsonResponse({}),
      redirect('/b', 302),
      jsonResponse({}),
      redirect('/c', 307),
      jsonResponse({}),
      redirect('/d', 308),
      jsonResponse({}),
    ]);
    const client = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fn, redirect: 'same-origin' });
    await client.fetchJson('POST', '/x', { body: { a: 1 } });
    await client.fetchJson('POST', '/x', { body: { a: 1 } });
    await client.fetchJson('PUT', '/x', { body: { a: 1 } });
    await client.fetchJson('POST', '/x', { body: { a: 1 } });
    const hop = (i: number) => calls[i]!.init;
    expect([hop(1).method, hop(1).body, (hop(1).headers as Record<string, string>)['Content-Type']]).toEqual([
      'GET',
      undefined,
      undefined,
    ]);
    expect([hop(3).method, hop(3).body]).toEqual(['GET', undefined]);
    expect([hop(5).method, hop(5).body]).toEqual(['PUT', '{"a":1}']);
    expect([hop(7).method, hop(7).body]).toEqual(['POST', '{"a":1}']);
  });

  it('treats a 3xx that is not a redirect, or has no Location, as an ordinary response', async () => {
    const { fn } = stubFetch([redirect(undefined, 304)]);
    const client = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fn, redirect: 'same-origin' });
    const raw = await client.fetchRaw('GET', '/x').catch((e: unknown) => e);
    // 304 is not ok → ApiError from the normal non-2xx path, not a redirect error
    expect(raw).not.toBeInstanceOf(RedirectRefusedError);
  });

  it('cancels the body of each redirect response it follows', async () => {
    const cancel = vi.fn(async () => {});
    const hop = redirect('/next');
    Object.defineProperty(hop, 'body', { value: { cancel } });
    const { fn } = stubFetch([hop, jsonResponse({})]);
    const client = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fn, redirect: 'same-origin' });
    await client.fetchJson('GET', '/x');
    expect(cancel).toHaveBeenCalled();
  });

  it("passes 'manual' and 'error' straight through to fetch, and omits redirect by default", async () => {
    const { fn, calls } = stubFetch([jsonResponse({}), jsonResponse({}), jsonResponse({})]);
    await createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fn, redirect: 'manual' }).fetchJson('GET', '/');
    await createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fn, redirect: 'error' }).fetchJson('GET', '/');
    await createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: fn }).fetchJson('GET', '/');
    expect(calls.map((c) => c.init.redirect)).toEqual(['manual', 'error', undefined]);
    expect('redirect' in calls[2]!.init).toBe(false);
  });
});
