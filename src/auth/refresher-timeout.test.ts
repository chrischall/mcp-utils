import { describe, it, expect, vi, afterEach } from 'vitest';
import { withCallSignal } from '../cancel/index.js';
import { RequestTimeoutError } from '../http/index.js';
import { createOAuth2Refresher } from './index.js';

/**
 * Fleet audit 2026-09 cluster 1 (#977 alphaportal): the refresh_token POST
 * went out with no timeout and no signal, so a hung token endpoint held
 * every tool call that needed a token until the host killed it, and a
 * cancelled call kept waiting on it.
 */

const ENDPOINT = 'https://auth.svc.test/oauth/token';

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** A fetch that never answers until its signal aborts. */
function hangingFetch(seen: Array<AbortSignal | undefined>): typeof fetch {
  return ((_url: string, init: RequestInit) => {
    seen.push(init.signal ?? undefined);
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(abortError()));
    });
  }) as unknown as typeof fetch;
}

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createOAuth2Refresher timeout', () => {
  it('bounds a hung token endpoint at 30 s by default', async () => {
    vi.useFakeTimers();
    const seen: Array<AbortSignal | undefined> = [];
    const refresh = createOAuth2Refresher({ endpoint: ENDPOINT, refreshToken: 'rt', fetchImpl: hangingFetch(seen) });
    const p = refresh();
    const assertion = expect(p).rejects.toMatchObject({ name: 'RequestTimeoutError', timeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it('honours a custom timeout', async () => {
    vi.useFakeTimers();
    const refresh = createOAuth2Refresher({
      endpoint: ENDPOINT,
      refreshToken: 'rt',
      timeout: 5_000,
      fetchImpl: hangingFetch([]),
    });
    const p = refresh();
    const assertion = expect(p).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    await expect(p).rejects.toThrow(/auth\.svc\.test.*5000ms/);
  });

  it('covers a body that stalls after the headers', async () => {
    vi.useFakeTimers();
    const fetchImpl = (async () =>
      new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({ endpoint: ENDPOINT, refreshToken: 'rt', timeout: 1_000, fetchImpl });
    const p = refresh();
    const assertion = expect(p).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('covers an error body that stalls', async () => {
    vi.useFakeTimers();
    const fetchImpl = (async () =>
      new Response(new ReadableStream({ start() {} }), { status: 500 })) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({ endpoint: ENDPOINT, refreshToken: 'rt', timeout: 1_000, fetchImpl });
    const p = refresh();
    const assertion = expect(p).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('sends no signal when the timeout is disabled (0 or false) outside a tool call', async () => {
    for (const timeout of [0, false] as const) {
      const seen: Array<AbortSignal | undefined> = [];
      const fetchImpl = ((_url: string, init: RequestInit) => {
        seen.push(init.signal ?? undefined);
        return Promise.resolve(tokenResponse({ access_token: 'at' }));
      }) as unknown as typeof fetch;
      const refresh = createOAuth2Refresher({ endpoint: ENDPOINT, refreshToken: 'rt', timeout, fetchImpl });
      await expect(refresh()).resolves.toMatchObject({ accessToken: 'at' });
      expect(seen).toEqual([undefined]);
    }
  });

  it('disarms the timer once the exchange succeeds', async () => {
    vi.useFakeTimers();
    const fetchImpl = (async () => tokenResponse({ access_token: 'at' })) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({ endpoint: ENDPOINT, refreshToken: 'rt', fetchImpl });
    await expect(refresh()).resolves.toMatchObject({ accessToken: 'at' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an unparseable success body as "no access_token", not a timeout', async () => {
    const fetchImpl = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({ endpoint: ENDPOINT, refreshToken: 'rt', fetchImpl });
    await expect(refresh()).rejects.toThrow(/no access_token/);
  });

  it('names a non-URL endpoint generically in the timeout message', async () => {
    vi.useFakeTimers();
    const refresh = createOAuth2Refresher({
      endpoint: 'not a url',
      refreshToken: 'rt',
      timeout: 10,
      fetchImpl: hangingFetch([]),
    });
    const p = refresh();
    const assertion = expect(p).rejects.toThrow(/OAuth2 token endpoint/);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});

describe('createOAuth2Refresher and the caller’s cancellation', () => {
  it('does not start an exchange for a caller that has already gone', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse({ access_token: 'at' }));
    const refresh = createOAuth2Refresher({
      endpoint: ENDPOINT,
      refreshToken: 'rt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const p = withCallSignal(AbortSignal.abort(new Error('gone')), () => refresh());
    await expect(p).rejects.toThrow('gone');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('releases a cancelled caller at once, but lets the shared exchange finish so a rotated token is kept', async () => {
    let answer!: (r: Response) => void;
    const fetchImpl = (() => new Promise<Response>((r) => (answer = r))) as unknown as typeof fetch;
    const onRotate = vi.fn();
    const refresh = createOAuth2Refresher({ endpoint: ENDPOINT, refreshToken: 'rt-1', fetchImpl, onRotate });

    const ac = new AbortController();
    const cancelled = withCallSignal(ac.signal, () => refresh());
    const patient = refresh(); // a second caller, coalesced onto the same exchange
    await new Promise((r) => setTimeout(r, 0));

    ac.abort(new Error('caller cancelled'));
    await expect(cancelled).rejects.toThrow('caller cancelled');

    // The POST may already have rotated the token upstream; abandoning it
    // would lose the only live refresh token. It completes for everyone else.
    answer(tokenResponse({ access_token: 'at-2', refresh_token: 'rt-2' }));
    await expect(patient).resolves.toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
    expect(onRotate).toHaveBeenCalledWith('rt-2');
  });

  it('a caller whose signal never fires gets the result as before', async () => {
    const fetchImpl = (async () => tokenResponse({ access_token: 'at' })) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({ endpoint: ENDPOINT, refreshToken: 'rt', fetchImpl });
    const ac = new AbortController();
    await expect(withCallSignal(ac.signal, () => refresh())).resolves.toMatchObject({ accessToken: 'at' });
    ac.abort(); // after settling: must surface nowhere
    await new Promise((r) => setTimeout(r, 0));
  });
});
