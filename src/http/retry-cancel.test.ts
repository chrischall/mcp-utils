/** fleet-audit#1443: createApiClient's 429 wait honours the caller's cancellation. */
import { describe, expect, it, vi } from 'vitest';
import { withCallSignal } from '../cancel/index.js';
import { createApiClient } from './index.js';

const tooMany = () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } });

describe('createApiClient retry wait', () => {
  it('a call cancelled while waiting to retry a 429 rejects at once and sends nothing more', async () => {
    const fetchImpl = vi.fn(async () => tooMany());
    const api = createApiClient({ baseUrl: 'https://api.example.com', getToken: () => 'T', fetchImpl, retry: { count: 3, delayMs: 60_000 } });
    const ac = new AbortController();
    const started = performance.now();
    const pending = withCallSignal(ac.signal, () => api.fetchJson('GET', '/x'));
    setTimeout(() => ac.abort(), 20);
    const err = await pending.catch((e: unknown) => e);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect((err as Error).name).toBe('AbortError');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('races an injected sleep against the cancellation too', async () => {
    const fetchImpl = vi.fn(async () => tooMany());
    const api = createApiClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'T',
      fetchImpl,
      retry: { count: 1, delayMs: 10 },
      sleep: () => new Promise(() => {}),
    });
    const ac = new AbortController();
    const reason = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const pending = withCallSignal(ac.signal, () => api.fetchJson('GET', '/x'));
    setTimeout(() => ac.abort(reason), 10);
    await expect(pending).rejects.toBe(reason);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('still waits and retries when nothing cancels', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(Response.json({ ok: 1 }));
    const waits: number[] = [];
    const api = createApiClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'T',
      fetchImpl,
      retry: { count: 1, delayMs: 7 },
      sleep: async (ms) => void waits.push(ms),
    });
    await expect(api.fetchJson('GET', '/x')).resolves.toEqual({ ok: 1 });
    expect(waits).toEqual([7]);
  });
});
