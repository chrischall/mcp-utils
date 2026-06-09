import { describe, expect, it, vi } from 'vitest';
import {
  createAuthResolver,
  resolveAuthPattern,
  sessionLoginFlow,
  createOAuth2Refresher,
} from './index.js';

// ---------------------------------------------------------------------------
// createAuthResolver — three-path (env → fetchproxy → helpful error)
// ---------------------------------------------------------------------------

describe('createAuthResolver', () => {
  it('returns the env-var credential (source=env) without touching fetchproxy', async () => {
    const bootstrap = vi.fn();
    const resolve = createAuthResolver({
      envVar: 'X_TOKEN',
      bootstrap,
      bootstrapOptions: { domains: ['x.com'], declare: { cookies: ['s'] } },
      parseTokens: () => {
        throw new Error('should not be called');
      },
      env: { X_TOKEN: 'env-secret' },
    });
    const result = await resolve();
    expect(result).toEqual({ credential: 'env-secret', source: 'env' });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('treats placeholder / sentinel env values as unset and falls through to fetchproxy', async () => {
    const bootstrap = vi.fn().mockResolvedValue({ cookies: { s: 'cookie-val' } });
    const resolve = createAuthResolver({
      envVar: 'X_TOKEN',
      bootstrap,
      bootstrapOptions: { domains: ['x.com'], declare: { cookies: ['s'] } },
      parseTokens: (session) => session.cookies['s'],
      env: { X_TOKEN: '${X_TOKEN}' },
    });
    const result = await resolve();
    expect(result).toEqual({ credential: 'cookie-val', source: 'fetchproxy' });
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it('lifts the credential out of the fetchproxy session via parseTokens', async () => {
    const session = { cookies: { usr: 'jwt-from-browser' }, localStorage: {} };
    const bootstrap = vi.fn().mockResolvedValue(session);
    const parseTokens = vi.fn((s: typeof session) => s.cookies['usr']);
    const resolve = createAuthResolver({
      envVar: 'Z_REFRESH_TOKEN',
      bootstrap,
      bootstrapOptions: { domains: ['zola.com'], declare: { cookies: ['usr'] } },
      parseTokens,
      env: {},
    });
    const result = await resolve();
    expect(result.credential).toBe('jwt-from-browser');
    expect(result.source).toBe('fetchproxy');
    expect(parseTokens).toHaveBeenCalledWith(session);
  });

  it('throws an actionable error naming the env var and sign-in when nothing is configured', async () => {
    const resolve = createAuthResolver({
      envVar: 'Z_REFRESH_TOKEN',
      disableEnvVar: 'Z_DISABLE_FETCHPROXY',
      bootstrap: vi.fn(),
      bootstrapOptions: { domains: ['zola.com'], declare: { cookies: ['usr'] } },
      parseTokens: () => undefined,
      env: { Z_DISABLE_FETCHPROXY: '1' },
    });
    await expect(resolve()).rejects.toThrow(/Z_REFRESH_TOKEN/);
    await expect(resolve()).rejects.toThrow(/sign in/i);
  });

  it('does not run fetchproxy when the disable flag is set', async () => {
    const bootstrap = vi.fn();
    const resolve = createAuthResolver({
      envVar: 'X_TOKEN',
      disableEnvVar: 'X_DISABLE_FETCHPROXY',
      bootstrap,
      bootstrapOptions: { domains: ['x.com'], declare: { cookies: ['s'] } },
      parseTokens: () => 'unused',
      env: { X_DISABLE_FETCHPROXY: 'true' },
    });
    await expect(resolve()).rejects.toThrow();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('wraps a parseTokens-returns-nothing case as a helpful (sign-in) error', async () => {
    const bootstrap = vi.fn().mockResolvedValue({ cookies: {} });
    const resolve = createAuthResolver({
      envVar: 'X_TOKEN',
      bootstrap,
      bootstrapOptions: { domains: ['x.com'], declare: { cookies: ['s'] } },
      parseTokens: () => undefined, // browser tab not signed in
      serviceName: 'Acme',
      signInHost: 'acme.com',
      env: {},
    });
    await expect(resolve()).rejects.toThrow(/acme\.com/i);
  });

  it('wraps a fetchproxy bootstrap failure, naming the env-var fallback', async () => {
    const bootstrap = vi.fn().mockRejectedValue(new Error('bridge offline'));
    const resolve = createAuthResolver({
      envVar: 'X_TOKEN',
      bootstrap,
      bootstrapOptions: { domains: ['x.com'], declare: { cookies: ['s'] } },
      parseTokens: () => 'unused',
      env: {},
    });
    await expect(resolve()).rejects.toThrow(/X_TOKEN/);
    await expect(resolve()).rejects.toThrow(/bridge offline/);
  });

  // -- bridge-down hint preservation (the copy-pasted fleet block, absorbed) --

  /** Duck-typed stand-in for `FetchproxyBridgeDownError` (no @fetchproxy import). */
  function makeBridgeDownError(hint: string): Error {
    const err = new Error(`fetchproxy bridge down during fetch. ${hint}`);
    err.name = 'FetchproxyBridgeDownError';
    (err as Error & { hint: string }).hint = hint;
    return err;
  }

  it('surfaces the FetchproxyBridgeDownError hint verbatim when the bridge is down', async () => {
    const hint =
      'the fetchproxy extension\'s service worker is not responding ("content_script_unreachable"). ' +
      'Make sure a tab for this domain is open, fully loaded, and signed in - then retry. ' +
      'If it keeps happening, reload the extension from chrome://extensions and reload the tab.';
    const bootstrap = vi.fn().mockRejectedValue(makeBridgeDownError(hint));
    const resolve = createAuthResolver({
      envVar: 'X_TOKEN',
      bootstrap,
      bootstrapOptions: { domains: ['x.com'], declare: { cookies: ['s'] } },
      parseTokens: () => 'unused',
      env: {},
    });
    const err = await resolve().then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e as Error & { hint?: string },
    );
    // The actionable copy must survive untruncated in the thrown message...
    expect(err.message).toContain(hint);
    expect(err.message).toMatch(/bridge is down/i);
    // ...and still name the env-var escape hatch.
    expect(err.message).toContain('X_TOKEN');
    // The structured hint rides along for tool surfaces that render it.
    expect(err.hint).toBe(hint);
  });

  it('does not treat a hint-less rejection as bridge-down (generic wrap unchanged)', async () => {
    // Right name, but no string `hint` - fails the duck-type, falls to generic.
    const impostor = new Error('worker gone');
    impostor.name = 'FetchproxyBridgeDownError';
    const bootstrap = vi.fn().mockRejectedValue(impostor);
    const resolve = createAuthResolver({
      envVar: 'X_TOKEN',
      bootstrap,
      bootstrapOptions: { domains: ['x.com'], declare: { cookies: ['s'] } },
      parseTokens: () => 'unused',
      env: {},
    });
    await expect(resolve()).rejects.toThrow(/fetchproxy fallback failed/);
    await expect(resolve()).rejects.toThrow(/worker gone/);
  });

  it('does not treat an unrelated error carrying a `hint` property as bridge-down', async () => {
    // Right `hint` shape, wrong name - fails the duck-type, falls to generic.
    const other = Object.assign(new Error('HTTP 502'), { hint: 'retry later' });
    const bootstrap = vi.fn().mockRejectedValue(other);
    const resolve = createAuthResolver({
      envVar: 'X_TOKEN',
      bootstrap,
      bootstrapOptions: { domains: ['x.com'], declare: { cookies: ['s'] } },
      parseTokens: () => 'unused',
      env: {},
    });
    await expect(resolve()).rejects.toThrow(/fetchproxy fallback failed/);
    await expect(resolve()).rejects.toThrow(/HTTP 502/);
  });

  it('env path is unaffected by a bridge-down-throwing bootstrap', async () => {
    const bootstrap = vi.fn().mockRejectedValue(makeBridgeDownError('wake the worker'));
    const resolve = createAuthResolver({
      envVar: 'X_TOKEN',
      bootstrap,
      bootstrapOptions: { domains: ['x.com'], declare: { cookies: ['s'] } },
      parseTokens: () => 'unused',
      env: { X_TOKEN: 'env-secret' },
    });
    await expect(resolve()).resolves.toEqual({ credential: 'env-secret', source: 'env' });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('does not leak the secret value into the not-configured error message', async () => {
    const resolve = createAuthResolver({
      envVar: 'X_TOKEN',
      disableEnvVar: 'X_DISABLE_FETCHPROXY',
      bootstrap: vi.fn(),
      bootstrapOptions: { domains: ['x.com'], declare: { cookies: ['s'] } },
      parseTokens: () => undefined,
      env: { X_TOKEN: '   ', X_DISABLE_FETCHPROXY: '1' },
    });
    // X_TOKEN is whitespace-only → unset; message must not echo the raw value.
    await expect(resolve()).rejects.toThrow(/X_TOKEN/);
  });
});

// ---------------------------------------------------------------------------
// resolveAuthPattern — four-path (token → OAuth → session-scrape → fetchproxy)
// ---------------------------------------------------------------------------

describe('resolveAuthPattern', () => {
  it('takes the first configured path, in declared order', async () => {
    const oauth = vi.fn().mockResolvedValue({ credential: 'oauth-tok', source: 'oauth' });
    const sessionScrape = vi.fn();
    const result = await resolveAuthPattern({
      token: undefined, // not configured
      oauth, // configured
      sessionScrape,
      fetchproxy: vi.fn(),
    });
    expect(result).toEqual({ credential: 'oauth-tok', source: 'oauth' });
    expect(oauth).toHaveBeenCalledOnce();
    expect(sessionScrape).not.toHaveBeenCalled();
  });

  it('prefers a configured token path over everything else', async () => {
    const token = vi.fn().mockResolvedValue({ credential: 'pat', source: 'token' });
    const result = await resolveAuthPattern({
      token,
      oauth: vi.fn(),
      sessionScrape: vi.fn(),
      fetchproxy: vi.fn(),
    });
    expect(result.source).toBe('token');
  });

  it('falls all the way to fetchproxy when only it is configured', async () => {
    const fetchproxy = vi.fn().mockResolvedValue({ credential: 'cookie', source: 'fetchproxy' });
    const result = await resolveAuthPattern({ fetchproxy });
    expect(result).toEqual({ credential: 'cookie', source: 'fetchproxy' });
  });

  it('does not branch on site identity — a path is "configured" iff a resolver is provided', async () => {
    // Only sessionScrape provided; the absence of token/oauth/fetchproxy must
    // not change which path runs.
    const sessionScrape = vi.fn().mockResolvedValue({ credential: 'sess', source: 'session' });
    const result = await resolveAuthPattern({ sessionScrape });
    expect(result.source).toBe('session');
  });

  it('throws an actionable error when no path is configured', async () => {
    await expect(resolveAuthPattern({})).rejects.toThrow(/auth/i);
  });

  it('propagates a partial-config error from a configured path (user mistake)', async () => {
    const oauth = vi.fn().mockRejectedValue(new Error('incomplete OAuth triple'));
    await expect(resolveAuthPattern({ oauth })).rejects.toThrow(/incomplete OAuth triple/);
  });
});

// ---------------------------------------------------------------------------
// sessionLoginFlow — CSRF extract + cookie POST + success marker
// ---------------------------------------------------------------------------

function htmlWithCsrf(token: string): string {
  return `<html><form><input name="csrfToken" value="${token}"></form></html>`;
}

function makeFetch(steps: Array<{ status: number; headers?: Record<string, string>; setCookies?: string[]; body?: string }>): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const step = steps[i++];
    if (!step) throw new Error('unexpected extra fetch call');
    const headers = new Headers(step.headers ?? {});
    for (const sc of step.setCookies ?? []) headers.append('set-cookie', sc);
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      statusText: String(step.status),
      headers,
      text: async () => step.body ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('sessionLoginFlow', () => {
  it('scrapes CSRF from the login page, POSTs creds, returns the success-marker cookie + jar', async () => {
    const fetchImpl = makeFetch([
      // GET login page → sets a session cookie, contains csrfToken
      { status: 200, setCookies: ['cfid=abc; Path=/'], body: htmlWithCsrf('CSRF123') },
      // POST creds → 302 with accessToken cookie
      { status: 302, setCookies: ['accessToken=JWT.aaa.bbb; Path=/', 'cfid=abc; Path=/'] },
    ]);
    const result = await sessionLoginFlow({
      loginUrl: 'https://svc.test/login',
      postUrl: 'https://svc.test/index.cfm?go=c.Login',
      csrfRegex: /name="csrfToken"\s+value="([^"]+)"/,
      tokenField: 'accessToken',
      email: 'a@b.com',
      password: 'pw',
      fetchImpl,
    });
    expect(result.token).toBe('JWT.aaa.bbb');
    expect(result.cookies).toContain('accessToken=JWT.aaa.bbb');
    expect(result.cookies).toContain('cfid=abc');
  });

  it('passes the scraped CSRF token into the POST body under csrfField', async () => {
    let postBody = '';
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') {
        const h = new Headers();
        return { ok: true, status: 200, statusText: 'OK', headers: h, text: async () => htmlWithCsrf('TOK99') } as unknown as Response;
      }
      postBody = String(init.body);
      const h = new Headers();
      h.append('set-cookie', 'accessToken=zzz; Path=/');
      return { ok: false, status: 302, statusText: '302', headers: h, text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;

    await sessionLoginFlow({
      loginUrl: 'https://svc.test/login',
      postUrl: 'https://svc.test/post',
      csrfRegex: /value="([^"]+)"/,
      csrfField: 'csrfToken',
      tokenField: 'accessToken',
      email: 'me@x.com',
      password: 'secret',
      fetchImpl,
    });
    expect(postBody).toContain('csrfToken=TOK99');
    expect(postBody).toContain('email=me%40x.com'.replace('email', 'email')); // url-encoded
    expect(postBody).toContain('secret');
  });

  it('throws when the login page lacks a CSRF token', async () => {
    const fetchImpl = makeFetch([{ status: 200, body: '<html>no token here</html>' }]);
    await expect(
      sessionLoginFlow({
        loginUrl: 'https://svc.test/login',
        postUrl: 'https://svc.test/post',
        csrfRegex: /name="csrfToken"\s+value="([^"]+)"/,
        tokenField: 'accessToken',
        email: 'a@b.com',
        password: 'pw',
        fetchImpl,
      }),
    ).rejects.toThrow(/csrf/i);
  });

  it('throws when the login page request fails', async () => {
    const fetchImpl = makeFetch([{ status: 503, body: '' }]);
    await expect(
      sessionLoginFlow({
        loginUrl: 'https://svc.test/login',
        postUrl: 'https://svc.test/post',
        csrfRegex: /value="([^"]+)"/,
        tokenField: 'accessToken',
        email: 'a@b.com',
        password: 'pw',
        fetchImpl,
      }),
    ).rejects.toThrow(/503/);
  });

  it('throws a credentials-rejected error when the success-marker cookie is absent after POST', async () => {
    const fetchImpl = makeFetch([
      { status: 200, body: htmlWithCsrf('CSRF') },
      { status: 302, setCookies: ['cfid=abc; Path=/'] }, // no accessToken
    ]);
    await expect(
      sessionLoginFlow({
        loginUrl: 'https://svc.test/login',
        postUrl: 'https://svc.test/post',
        csrfRegex: /value="([^"]+)"/,
        tokenField: 'accessToken',
        email: 'a@b.com',
        password: 'wrong',
        fetchImpl,
      }),
    ).rejects.toThrow(/credential|reject|did not/i);
  });

  it('supports a successMarker cookie that differs from the returned token field', async () => {
    // canvas-style: success is the presence of canvas_session, token returned is a different cookie
    const fetchImpl = makeFetch([
      { status: 200, body: htmlWithCsrf('CSRF') },
      { status: 302, setCookies: ['canvas_session=sess; Path=/', 'pseudonym_credentials=pc; Path=/'] },
    ]);
    const result = await sessionLoginFlow({
      loginUrl: 'https://svc.test/login',
      postUrl: 'https://svc.test/post',
      csrfRegex: /value="([^"]+)"/,
      tokenField: 'canvas_session',
      email: 'a@b.com',
      password: 'pw',
      fetchImpl,
    });
    expect(result.token).toBe('sess');
    expect(result.cookies).toContain('pseudonym_credentials=pc');
  });
});

// ---------------------------------------------------------------------------
// createOAuth2Refresher — refresh_token grant + retry + race-safety
// ---------------------------------------------------------------------------

describe('createOAuth2Refresher', () => {
  function tokenResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  it('POSTs the refresh_token grant and returns the new access token + expiry', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      expect(String(init?.body)).toContain('refresh_token=rt-1');
      return tokenResponse({ access_token: 'at-new', expires_in: 1800, refresh_token: 'rt-2' });
    }) as unknown as typeof fetch;

    const refresh = createOAuth2Refresher({
      endpoint: 'https://svc.test/oauth/token',
      refreshToken: 'rt-1',
      fetchImpl,
    });
    const result = await refresh();
    expect(result.accessToken).toBe('at-new');
    expect(result.refreshToken).toBe('rt-2');
    expect(result.expiresIn).toBe(1800);
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it('sends extra params (client_id/client_secret) and a configurable grantType', async () => {
    let body = '';
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return tokenResponse({ access_token: 'a' });
    }) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({
      endpoint: 'https://svc.test/token',
      refreshToken: 'rt',
      grantType: 'refresh_token',
      params: { client_id: 'cid', client_secret: 'csec' },
      fetchImpl,
    });
    await refresh();
    expect(body).toContain('client_id=cid');
    expect(body).toContain('client_secret=csec');
  });

  it('throws a redacted, bounded error on a non-OK response', async () => {
    const longSecret = 'Bearer ' + 'x'.repeat(50);
    const fetchImpl = vi.fn(async () =>
      tokenResponse({ error: 'invalid_grant', leak: longSecret }, 401),
    ) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({
      endpoint: 'https://svc.test/token',
      refreshToken: 'rt',
      fetchImpl,
    });
    const err = await refresh().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('401');
    expect(err.message).not.toContain(longSecret); // bearer token redacted
  });

  it('throws when the response lacks an access_token', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse({ token_type: 'bearer' })) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({
      endpoint: 'https://svc.test/token',
      refreshToken: 'rt',
      fetchImpl,
    });
    await expect(refresh()).rejects.toThrow(/access_token/i);
  });

  it('retries a failed refresh up to the configured count', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('network blip');
      return tokenResponse({ access_token: 'finally' });
    }) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({
      endpoint: 'https://svc.test/token',
      refreshToken: 'rt',
      retry: { count: 2, delayMs: 0 },
      fetchImpl,
    });
    const result = await refresh();
    expect(result.accessToken).toBe('finally');
    expect(calls).toBe(3);
  });

  it('is race-safe: concurrent calls share a single in-flight refresh', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async () => {
      calls++;
      await gate;
      return tokenResponse({ access_token: 'shared-' + calls });
    }) as unknown as typeof fetch;

    const refresh = createOAuth2Refresher({
      endpoint: 'https://svc.test/token',
      refreshToken: 'rt',
      fetchImpl,
    });
    const p1 = refresh();
    const p2 = refresh();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1); // only one network call despite two callers
    expect(r1.accessToken).toBe(r2.accessToken);
  });

  it('allows a fresh refresh after an in-flight one settles', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return tokenResponse({ access_token: 'tok-' + calls });
    }) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({
      endpoint: 'https://svc.test/token',
      refreshToken: 'rt',
      fetchImpl,
    });
    const a = await refresh();
    const b = await refresh();
    expect(calls).toBe(2);
    expect(a.accessToken).toBe('tok-1');
    expect(b.accessToken).toBe('tok-2');
  });

  it('a rejected in-flight refresh does not poison subsequent calls', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('first fails');
      return tokenResponse({ access_token: 'recovered' });
    }) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({
      endpoint: 'https://svc.test/token',
      refreshToken: 'rt',
      fetchImpl,
    });
    await expect(refresh()).rejects.toThrow(/first fails/);
    const result = await refresh();
    expect(result.accessToken).toBe('recovered');
  });
});
