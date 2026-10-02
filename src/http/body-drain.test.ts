import { describe, it, expect } from 'vitest';
import { createApiClient, RateLimitedError, UnauthorizedError } from './index.js';

// fleet-audit #1056: every path that abandons a Response must cancel its body.
// With undici an unread, uncancelled body keeps its socket reserved until GC,
// so a burst of 429s would pin one connection per retry against the upstream's
// per-host limit for the whole tool call.

/** A body stream that records whether it was cancelled. */
function trackedBody(): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    // Never enqueue: a body nobody reads stays pending, like a real socket.
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

/** A Response whose body stream records whether it was cancelled. */
function trackedResponse(status: number, contentType = 'text/plain'): { res: Response; cancelled: () => boolean } {
  const { body, cancelled } = trackedBody();
  return { res: new Response(body, { status, headers: { 'content-type': contentType } }), cancelled };
}

function queueFetch(responses: Response[]): typeof fetch {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)]!) as unknown as typeof fetch;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createApiClient discards abandoned response bodies (#1056)', () => {
  it('cancels a retried 429 body before replaying', async () => {
    const first = trackedResponse(429);
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      fetchImpl: queueFetch([first.res, new Response('{"ok":1}', { status: 200 })]),
      retry: { count: 1, delayMs: 0 },
    });
    await expect(client.fetchJson('GET', '/x')).resolves.toEqual({ ok: 1 });
    await flush();
    expect(first.cancelled()).toBe(true);
  });

  it('cancels a retried 5xx body under custom retry statuses', async () => {
    const first = trackedResponse(503);
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      fetchImpl: queueFetch([first.res, new Response('ok', { status: 200 })]),
      retry: { count: 1, delayMs: 0, statuses: [429, 503] },
    });
    await expect(client.fetchHtml('GET', '/x')).resolves.toBe('ok');
    await flush();
    expect(first.cancelled()).toBe(true);
  });

  for (const method of ['fetchJson', 'fetchHtml', 'fetchRaw'] as const) {
    it(`${method}: cancels the body of an exhausted 429 before throwing`, async () => {
      const last = trackedResponse(429);
      const client = createApiClient({
        baseUrl: 'https://api.example.com',
        fetchImpl: queueFetch([last.res]),
        retry: { count: 0, delayMs: 0 },
      });
      await expect(client[method]('GET', '/x')).rejects.toBeInstanceOf(RateLimitedError);
      await flush();
      expect(last.cancelled()).toBe(true);
    });

    it(`${method}: cancels the body of a JSON 401 it never reads`, async () => {
      const r = trackedResponse(401, 'application/json');
      const client = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: queueFetch([r.res]) });
      await expect(client[method]('GET', '/x')).rejects.toBeInstanceOf(UnauthorizedError);
      await flush();
      expect(r.cancelled()).toBe(true);
    });
  }

  it('fetchJson: cancels the body of a 204', async () => {
    const r = trackedBody();
    // A 204 Response cannot carry a body in the WHATWG constructor, so hand the
    // client a duck-typed one whose stream still records the cancel.
    const fake = { status: 204, ok: true, headers: new Headers(), body: r.body } as unknown as Response;
    const client = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl: queueFetch([fake]) });
    await expect(client.fetchJson('GET', '/x')).resolves.toBeUndefined();
    await flush();
    expect(r.cancelled()).toBe(true);
  });

  it('tolerates a fetchImpl whose Response has no body or no cancel()', async () => {
    const bodyless = { status: 429, ok: false, headers: new Headers(), body: null } as unknown as Response;
    const odd = { status: 429, ok: false, headers: new Headers(), body: {} } as unknown as Response;
    for (const res of [bodyless, odd]) {
      const client = createApiClient({
        baseUrl: 'https://api.example.com',
        fetchImpl: queueFetch([res]),
        retry: { count: 0, delayMs: 0 },
      });
      await expect(client.fetchJson('GET', '/x')).rejects.toBeInstanceOf(RateLimitedError);
    }
  });
});
