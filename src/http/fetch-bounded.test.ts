import { describe, it, expect, vi, afterEach } from 'vitest';
import { withCallSignal } from '../cancel/index.js';
import { McpToolError } from '../errors/index.js';
import * as core from '../index.js';
import { fetchBounded, ResponseTooLargeError, RequestTimeoutError } from './index.js';

/**
 * Fleet audit 2026-09 cluster 1: ~20 clients that cannot use createApiClient
 * (cookie scrapers, multi-host clients, HTML readers, downloads) call `fetch`
 * bare — no timeout, no cancellation, the body read unbounded in time and in
 * size (#534/#783/#584 stalled body reads, #989/#1026 whole downloads
 * buffered). `fetchBounded` is the one call that gets all of it right.
 */

function abortError(): Error {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** A fetch that never answers until its signal aborts; records the init. */
function hangingFetch(inits: RequestInit[] = []): typeof fetch {
  return ((_url: string, init: RequestInit) => {
    inits.push(init);
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(abortError()));
    });
  }) as unknown as typeof fetch;
}

/** A response whose body never ends (and ignores aborts — a custom fetchImpl). */
function stalledBody(status = 200): typeof fetch {
  return (async () => new Response(new ReadableStream({ start() {} }), { status })) as unknown as typeof fetch;
}

function respond(body: BodyInit | null, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body, init)) as unknown as typeof fetch;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchBounded — reading', () => {
  it('is exported from the core barrel', () => {
    expect(core.fetchBounded).toBe(fetchBounded);
    expect(core.ResponseTooLargeError).toBe(ResponseTooLargeError);
  });

  it('returns the response and its text body by default', async () => {
    const r = await fetchBounded('https://x.test/a', undefined, {
      fetchImpl: respond('hello', { status: 200, headers: { 'x-k': 'v' } }),
    });
    expect(r.body).toBe('hello');
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
    expect(r.headers.get('x-k')).toBe('v');
    expect(r.res).toBeInstanceOf(Response);
  });

  it('parses JSON with read: "json", and an empty body is undefined', async () => {
    const r = await fetchBounded('https://x.test/a', undefined, {
      read: 'json',
      fetchImpl: respond('{"a":1}'),
    });
    expect(r.body).toEqual({ a: 1 });
    const empty = await fetchBounded('https://x.test/a', undefined, { read: 'json', fetchImpl: respond(null) });
    expect(empty.body).toBeUndefined();
  });

  it('turns a non-JSON body into an McpToolError that names the service but never echoes the body', async () => {
    const p = fetchBounded('https://x.test/a', undefined, {
      read: 'json',
      service: 'Example',
      fetchImpl: respond('<html>secret-token-abc</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    await expect(p).rejects.toBeInstanceOf(McpToolError);
    await expect(p).rejects.toThrow(/Example returned a non-JSON response \(HTTP 200, text\/html\)/);
    await expect(p).rejects.not.toThrow(/secret-token-abc/);
  });

  it('returns bytes with read: "bytes"', async () => {
    const r = await fetchBounded('https://x.test/a', undefined, {
      read: 'bytes',
      fetchImpl: respond(new Uint8Array([1, 2, 3])),
    });
    expect(r.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('read: "none" discards the body and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => {});
    const body = new ReadableStream({ start() {}, cancel });
    const r = await fetchBounded('https://x.test/a', undefined, {
      read: 'none',
      fetchImpl: (async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
    });
    expect(r.body).toBeUndefined();
    expect(r.status).toBe(202);
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not throw on a non-2xx: the caller decides', async () => {
    const r = await fetchBounded('https://x.test/a', undefined, { fetchImpl: respond('nope', { status: 404 }) });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.body).toBe('nope');
  });

  it('passes the caller’s init through (method, headers, body)', async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = ((_u: string, init: RequestInit) => {
      inits.push(init);
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;
    await fetchBounded('https://x.test/a', { method: 'POST', headers: { a: 'b' }, body: 'x' }, { fetchImpl });
    expect(inits[0]).toMatchObject({ method: 'POST', headers: { a: 'b' }, body: 'x' });
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('names a non-URL target by the string itself when no service is given', async () => {
    vi.useFakeTimers();
    const p = fetchBounded('relative/path', undefined, { timeoutMs: 10, fetchImpl: hangingFetch() });
    const assertion = expect(p).rejects.toThrow(/relative\/path/);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it('defaults to the global fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('global'));
    try {
      const r = await fetchBounded(new URL('https://x.test/a'));
      expect(r.body).toBe('global');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('fetchBounded — timeout', () => {
  it('bounds a hung request at 30 s by default', async () => {
    vi.useFakeTimers();
    const p = fetchBounded('https://slow.test/a', undefined, { fetchImpl: hangingFetch() });
    const assertion = expect(p).rejects.toMatchObject({ name: 'RequestTimeoutError', timeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    await expect(p).rejects.toThrow(/slow\.test/);
  });

  it('keeps the timer armed through the body read', async () => {
    vi.useFakeTimers();
    const p = fetchBounded('https://x.test/a', undefined, { timeoutMs: 1_000, fetchImpl: stalledBody() });
    const assertion = expect(p).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('disarms the timer once the body is read', async () => {
    vi.useFakeTimers();
    await fetchBounded('https://x.test/a', undefined, { fetchImpl: respond('ok') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('timeoutMs: 0 or false disables the timer (cancellation still applies)', async () => {
    for (const timeoutMs of [0, false] as const) {
      vi.useFakeTimers();
      const inits: RequestInit[] = [];
      const p = fetchBounded('https://x.test/a', undefined, { timeoutMs, fetchImpl: hangingFetch(inits) });
      let settled = false;
      p.catch(() => {}).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });
});

describe('fetchBounded — cancellation', () => {
  it('aborts when the ambient tool call is cancelled, with the caller’s reason (not a timeout)', async () => {
    const ac = new AbortController();
    const inits: RequestInit[] = [];
    const p = withCallSignal(ac.signal, () =>
      fetchBounded('https://x.test/a', undefined, { fetchImpl: hangingFetch(inits) }),
    );
    await tick();
    ac.abort(new Error('caller went away'));
    await expect(p).rejects.toThrow('caller went away');
    await expect(p).rejects.not.toBeInstanceOf(RequestTimeoutError);
    expect(inits[0]!.signal!.aborted).toBe(true);
  });

  it('honours a signal passed in init', async () => {
    const ac = new AbortController();
    const p = fetchBounded('https://x.test/a', { signal: ac.signal }, { fetchImpl: hangingFetch() });
    await tick();
    ac.abort(new Error('own signal'));
    await expect(p).rejects.toThrow('own signal');
  });

  it('cancels a stalled body read when the caller goes away', async () => {
    const ac = new AbortController();
    const p = withCallSignal(ac.signal, () =>
      fetchBounded('https://x.test/a', undefined, { timeoutMs: false, fetchImpl: stalledBody() }),
    );
    await tick();
    ac.abort('plain reason');
    await expect(p).rejects.toThrow('plain reason');
  });

  it('rejects at once for a caller that has already gone, without fetching', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'));
    const p = fetchBounded('https://x.test/a', { signal: AbortSignal.abort(new Error('gone')) }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(p).rejects.toThrow('gone');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes a non-abort fetch error through unchanged', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(fetchBounded('https://x.test/a', undefined, { fetchImpl })).rejects.toThrow('fetch failed');
  });
});

describe('fetchBounded — maxBytes', () => {
  it('refuses a declared Content-Length over the cap without reading the body', async () => {
    const cancel = vi.fn(async () => {});
    const body = new ReadableStream({ start() {}, cancel });
    const fetchImpl = (async () =>
      new Response(body, { headers: { 'content-length': '2000' } })) as unknown as typeof fetch;
    const p = fetchBounded('https://x.test/a', undefined, { maxBytes: 1000, service: 'Files', fetchImpl });
    await expect(p).rejects.toBeInstanceOf(ResponseTooLargeError);
    await expect(p).rejects.toMatchObject({ maxBytes: 1000 });
    await expect(p).rejects.toThrow(/Files.*1000/);
    expect(cancel).toHaveBeenCalled();
  });

  it('throws the same ResponseTooLargeError createApiClient does: an McpToolError of kind too_large', async () => {
    const err = await fetchBounded('https://x.test/a', undefined, {
      maxBytes: 2,
      fetchImpl: respond('secret body'),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
    expect((err as Error).name).toBe('ResponseTooLargeError');
    expect((err as Error).message).not.toContain('secret');
  });

  it('stops reading a body that exceeds the cap mid-stream', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(400));
      },
    });
    const p = fetchBounded('https://x.test/a', undefined, {
      maxBytes: 1000,
      read: 'bytes',
      fetchImpl: (async () => new Response(body)) as unknown as typeof fetch,
    });
    await expect(p).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(pulls).toBeLessThan(10);
  });

  it('accepts a body exactly at the cap', async () => {
    const r = await fetchBounded('https://x.test/a', undefined, {
      maxBytes: 5,
      fetchImpl: respond('12345'),
    });
    expect(r.body).toBe('12345');
  });

  it('ignores an unparseable Content-Length and counts the bytes instead', async () => {
    const r = await fetchBounded('https://x.test/a', undefined, {
      maxBytes: 5,
      fetchImpl: respond('abc', { headers: { 'content-length': 'banana' } }),
    });
    expect(r.body).toBe('abc');
  });
});
