/**
 * A write whose request never produced a usable response has an UNKNOWN
 * outcome: the server may already have committed it. `createApiClient` used
 * to throw a plain `RequestTimeoutError` (or fetch's raw `TypeError`) for it,
 * which reads as "safe to retry" — and the model re-sent the email / booking
 * (fleet audit 2026-09, cluster 7: opentable #632, honeybook #1023,
 * office-outlook #1073, vibo #1135, untappd #1132).
 */
import { describe, it, expect, vi } from 'vitest';
import { withCallSignal } from '../cancel/index.js';
import { McpToolError, UpstreamFormatError, isTimeoutError } from '../errors/index.js';
import { createApiClient, RequestTimeoutError, WriteOutcomeUnknownError, type ApiClientOptions } from './index.js';

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** A fetch that never settles on its own — only an abort ends it. */
const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) return reject(abortError());
    signal.addEventListener('abort', () => reject(abortError()));
  })) as unknown as typeof fetch;

/** A Response whose headers arrive at once but whose body never finishes. */
function stalledBody(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"partial":'));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A Response whose body stream errors part-way through (a dropped connection). */
function brokenBody(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"partial":'));
      c.error(new TypeError('terminated'));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

function client(extra: Partial<ApiClientOptions> = {}) {
  return createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', serviceName: 'Example', ...extra });
}

async function timedOut<T>(p: Promise<T>, ms: number): Promise<unknown> {
  const settled = p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

describe('createApiClient: a write whose outcome is unknown', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post'] as const) {
    it(`${method} that times out throws WriteOutcomeUnknownError, not a plain timeout`, async () => {
      vi.useFakeTimers();
      try {
        const api = client({ fetchImpl: hangingFetch, timeout: 5000 });
        const err = await timedOut(api.fetchJson(method, '/messages', { body: { to: 'x' } }), 5000);
        expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
        expect(err).toBeInstanceOf(McpToolError);
        expect(err).not.toBeInstanceOf(RequestTimeoutError);
        const e = err as WriteOutcomeUnknownError;
        expect(e.name).toBe('WriteOutcomeUnknownError');
        expect(e.outcomeUnknown).toBe(true);
        expect(e.timedOut).toBe(true);
        expect(e.timeoutMs).toBe(5000);
        expect(e.retrySafe).toBe(false);
        expect(e.method).toBe(method.toUpperCase());
        expect(e.message).toMatch(/timed out after 5000ms/);
        expect(e.message).toMatch(/may already have been applied/);
        expect(e.hint).toMatch(/the write may have happened/i);
        expect(e.hint).toMatch(/do not resend blindly/i);
        expect(e.cause).toBeInstanceOf(RequestTimeoutError);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it('is still a declared timeout, but never a retry-safe one', async () => {
    vi.useFakeTimers();
    try {
      const err = await timedOut(client({ fetchImpl: hangingFetch, timeout: 100 }).fetchJson('POST', '/a'), 100);
      // retryOnceOnTimeout (and any consumer following the convention)
      // retries a timeout only when `retrySafe !== false`.
      expect(isTimeoutError(err)).toBe(true);
      expect((err as { retrySafe?: unknown }).retrySafe).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a dropped connection on a write throws WriteOutcomeUnknownError carrying the cause', async () => {
    const boom = new TypeError('fetch failed');
    const fetchImpl = (() => Promise.reject(boom)) as unknown as typeof fetch;
    const err = await client({ fetchImpl }).fetchJson('POST', '/bookings').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    const e = err as WriteOutcomeUnknownError;
    expect(e.timedOut).toBe(false);
    expect(e.timeoutMs).toBeUndefined();
    expect(e.cause).toBe(boom);
    expect(e.message).toMatch(/POST to Example failed: fetch failed/);
    expect(e.message).toMatch(/outcome is unknown/);
    expect(isTimeoutError(e)).toBe(false);
  });

  for (const method of ['fetchJson', 'fetchHtml', 'fetchRaw'] as const) {
    it(`${method}: a write whose response body stalls is outcome-unknown`, async () => {
      vi.useFakeTimers();
      try {
        const api = client({ fetchImpl: (async () => stalledBody()) as unknown as typeof fetch, timeout: 5000 });
        const err = await timedOut(api[method]('POST', '/a'), 5000);
        expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
        expect((err as WriteOutcomeUnknownError).timedOut).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it(`${method}: a write whose response body breaks off is outcome-unknown`, async () => {
      const api = client({ fetchImpl: (async () => brokenBody()) as unknown as typeof fetch });
      const err = await api[method]('POST', '/a').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
      expect((err as WriteOutcomeUnknownError).timedOut).toBe(false);
    });
  }

  it('a body read the timer aborts first (AbortError wins the race) is still this timeout', async () => {
    vi.useFakeTimers();
    try {
      // The body's own abort listener is registered at fetch time — before the
      // client's — so its AbortError settles the race first. It must not be
      // reported as a caller cancellation.
      const fetchImpl = ((_url: string, init: RequestInit) => {
        const text = new Promise<string>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(abortError()));
        });
        text.catch(() => {});
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: null,
          text: () => text,
        } as unknown as Response);
      }) as unknown as typeof fetch;
      const write = await timedOut(client({ fetchImpl, timeout: 5000 }).fetchJson('POST', '/a'), 5000);
      expect(write).toBeInstanceOf(WriteOutcomeUnknownError);
      const read = await timedOut(client({ fetchImpl, timeout: 5000 }).fetchJson('GET', '/a'), 5000);
      expect(read).toBeInstanceOf(RequestTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createApiClient: what is NOT outcome-unknown', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get'] as const) {
    it(`${method} keeps the plain RequestTimeoutError (a read is safe to retry)`, async () => {
      vi.useFakeTimers();
      try {
        const err = await timedOut(client({ fetchImpl: hangingFetch, timeout: 5000 }).fetchJson(method, '/a'), 5000);
        expect(err).toBeInstanceOf(RequestTimeoutError);
        expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it('a read’s network failure passes through unchanged', async () => {
    const boom = new TypeError('fetch failed');
    const fetchImpl = (() => Promise.reject(boom)) as unknown as typeof fetch;
    await expect(client({ fetchImpl }).fetchJson('GET', '/a')).rejects.toBe(boom);
  });

  it('a caller’s cancellation of a write is rethrown untouched', async () => {
    const api = client({ fetchImpl: hangingFetch, timeout: 60_000 });
    const controller = new AbortController();
    const call = withCallSignal(controller.signal, () => api.fetchJson('POST', '/slow'));
    controller.abort(new Error('caller went away'));
    const err = await call.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('a failure before anything was sent keeps its own error', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const tokenFailure = new Error('token mint failed');
    await expect(
      client({ fetchImpl, getToken: () => Promise.reject(tokenFailure) }).fetchJson('POST', '/a'),
    ).rejects.toBe(tokenFailure);
    await expect(client({ fetchImpl }).fetchJson('POST', '/a/../b')).rejects.not.toBeInstanceOf(
      WriteOutcomeUnknownError,
    );
    await expect(client({ fetchImpl }).fetchJson('POST', '/a', { form: {}, body: {} })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a timeout that fires while the token is still being minted is a plain timeout (nothing was sent)', async () => {
    vi.useFakeTimers();
    try {
      const getToken = () => new Promise<string>((resolve) => setTimeout(() => resolve('t'), 6000));
      const err = await timedOut(client({ fetchImpl: hangingFetch, getToken, timeout: 5000 }).fetchJson('POST', '/a'), 6000);
      expect(err).toBeInstanceOf(RequestTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an error the token manager raises after the response is not a transport failure', async () => {
    const refresh = new Error('refresh failed');
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const withAuth = async (call: (t: string) => Promise<Response>) => {
      await call('T');
      throw refresh;
    };
    await expect(
      createApiClient({ baseUrl: 'https://x.test', fetchImpl, tokenManager: { withAuth } }).fetchJson('POST', '/a'),
    ).rejects.toBe(refresh);
  });

  it('a write that got a 2xx with an unparseable body keeps UpstreamFormatError (the write ran)', async () => {
    const fetchImpl = (async () =>
      new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(client({ fetchImpl }).fetchJson('POST', '/a')).rejects.toBeInstanceOf(UpstreamFormatError);
  });

  it('idempotent: true on a request opts that POST out (a search sent as POST)', async () => {
    vi.useFakeTimers();
    try {
      const api = client({ fetchImpl: hangingFetch, timeout: 5000 });
      const err = await timedOut(api.fetchJson('POST', '/search', { body: {}, idempotent: true }), 5000);
      expect(err).toBeInstanceOf(RequestTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('idempotent is never sent upstream', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      calls.push(init);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await client({ fetchImpl }).fetchJson('POST', '/search', { body: { q: 1 }, idempotent: true });
    expect(calls[0]!.body).toBe('{"q":1}');
    expect(JSON.stringify(calls[0]!.headers)).not.toMatch(/idempotent/i);
  });

  it('writeOutcomeUnknown: false restores the plain errors for the whole client', async () => {
    const boom = new TypeError('fetch failed');
    const fetchImpl = (() => Promise.reject(boom)) as unknown as typeof fetch;
    await expect(client({ fetchImpl, writeOutcomeUnknown: false }).fetchJson('POST', '/a')).rejects.toBe(boom);
  });
});

describe('createApiClient writeOutcomeHint', () => {
  it('replaces the default hint (e.g. to name the tool that checks)', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const hint = 'The message may have been sent — check with outlook_list_messages before sending again.';
    const err = await client({ fetchImpl, writeOutcomeHint: hint }).fetchJson('POST', '/a').catch((e: unknown) => e);
    expect((err as WriteOutcomeUnknownError).hint).toBe(hint);
  });
});

describe('WriteOutcomeUnknownError', () => {
  it('can be constructed directly by a hand-rolled client', () => {
    const e = new WriteOutcomeUnknownError('Example', 'post', { timeoutMs: 1000, cause: new Error('x') });
    expect(e).toBeInstanceOf(McpToolError);
    expect(e.method).toBe('POST');
    expect(e.timedOut).toBe(true);
    expect(e.message).toBe(
      'POST to Example timed out after 1000ms — the write may already have been applied (outcome is unknown).',
    );
    const n = new WriteOutcomeUnknownError('Example', 'DELETE', { cause: new Error('socket hang up'), hint: 'h' });
    expect(n.timedOut).toBe(false);
    expect(n.hint).toBe('h');
    expect(n.message).toBe(
      'DELETE to Example failed: socket hang up — the write may already have been applied (outcome is unknown).',
    );
  });
});
