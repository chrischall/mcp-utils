/**
 * fleet-audit#1443: a retry's wait is the other piece of work a cancelled
 * tool call must be able to stop (the fetch already honours the ambient
 * signal), and an exponential backoff must not grow without bound.
 */
import { describe, expect, it, vi } from 'vitest';
import { withCallSignal } from '../cancel/index.js';
import { createGraphqlClient, type GraphqlClientOptions } from './index.js';

const ENDPOINT = 'https://api.example.com/graphql';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) } as unknown as Response;
}

function client(fetchImpl: unknown, extra: Partial<GraphqlClientOptions> = {}) {
  return createGraphqlClient({ endpoint: ENDPOINT, fetchImpl: fetchImpl as typeof fetch, ...extra });
}

describe('retry waits honour the caller\'s cancellation', () => {
  it('a call cancelled mid-backoff rejects at once with the abort, and sends no further attempt', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, {}));
    const ac = new AbortController();
    const c = client(fetchImpl, { retry: { count: 3, delayMs: 60_000 } });
    const started = performance.now();
    const pending = withCallSignal(ac.signal, () => c.request('query Q { ok }'));
    setTimeout(() => ac.abort(), 20);
    const err = await pending.catch((e: unknown) => e);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect((err as Error).name).toBe('AbortError');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('an injected sleep is raced against the cancellation too', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, {}));
    const ac = new AbortController();
    const reason = new Error('client cancelled');
    reason.name = 'AbortError';
    const c = client(fetchImpl, { retry: { count: 1, delayMs: 10 }, sleep: () => new Promise(() => {}) });
    const pending = withCallSignal(ac.signal, () => c.request('query Q { ok }'));
    setTimeout(() => ac.abort(reason), 10);
    await expect(pending).rejects.toBe(reason);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('a transport-error retry wait is cancellable as well', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const ac = new AbortController();
    const c = client(fetchImpl, { retry: { count: 2, delayMs: 60_000, transportErrors: true } });
    const pending = withCallSignal(ac.signal, () => c.request('query Q { ok }'));
    setTimeout(() => ac.abort(), 10);
    expect(((await pending.catch((e: unknown) => e)) as Error).name).toBe('AbortError');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('exponential backoff is capped', () => {
  function recorder() {
    const waits: number[] = [];
    return { waits, sleep: vi.fn(async (ms: number) => void waits.push(ms)) };
  }

  it('caps each wait at 30 s by default', async () => {
    const { waits, sleep } = recorder();
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    const c = client(fetchImpl, { sleep, retry: { count: 6, delayMs: 2000, statuses: [503], backoff: 'exponential' } });
    await c.request('query Q { ok }').catch(() => undefined);
    expect(waits).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('never cuts a plain fixed delay longer than 30 s short', async () => {
    const { waits, sleep } = recorder();
    const fetchImpl = vi.fn(async () => jsonResponse(429, {}));
    await client(fetchImpl, { sleep, retry: { count: 2, delayMs: 45_000 } }).request('query Q { ok }').catch(() => undefined);
    expect(waits).toEqual([45_000, 45_000]);
  });

  it('takes a maxBackoffMs, which also bounds the jittered wait', async () => {
    const { waits, sleep } = recorder();
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    const c = client(fetchImpl, {
      sleep,
      random: () => 0.99,
      retry: { count: 4, delayMs: 1000, statuses: [503], backoff: 'exponential', jitter: 0.5, maxBackoffMs: 5000 },
    });
    await c.request('query Q { ok }').catch(() => undefined);
    expect(waits).toEqual([1495, 2990, 5000, 5000]);
  });

  it('refuses a maxBackoffMs that is not a non-negative number', () => {
    expect(() => client(vi.fn(), { retry: { count: 1, delayMs: 1, maxBackoffMs: -1 } })).toThrow(TypeError);
    expect(() => client(vi.fn(), { retry: { count: 1, delayMs: 1, maxBackoffMs: Number.NaN } })).toThrow(TypeError);
  });
});
