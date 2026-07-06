import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient } from './index.js';

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

describe('createApiClient fetchRaw', () => {
  it('returns bytes, status, and content type for a binary response', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = vi.fn(async () =>
      new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    const raw = await client.fetchRaw('GET', '/img');
    expect(raw.status).toBe(200);
    expect(raw.contentType).toBe('image/png');
    expect(Buffer.from(raw.bytes)).toEqual(bytes);
    expect(raw.headers.get('content-type')).toBe('image/png');
  });

  it('maps non-2xx to ApiError with the redacted formatted message', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    await expect(client.fetchRaw('GET', '/missing')).rejects.toThrow(ApiError);
  });

  it('sends the auth header like fetchJson does', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-apikey']).toBe('k');
      return new Response('ok', { status: 200 });
    });
    const client = createApiClient({
      baseUrl: 'https://api.test',
      tokenHeader: 'x-apikey',
      getToken: () => 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.fetchRaw('GET', '/x');
    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe('createApiClient honorRetryAfter', () => {
  it('sleeps the Retry-After duration (not delayMs) before the retry', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(429, {}, { 'retry-after': '3' }))
      .mockResolvedValueOnce(jsonRes(200, { ok: true }));
    const client = createApiClient({
      baseUrl: 'https://api.test',
      retry: { count: 1, delayMs: 2000, statuses: [429, 503], honorRetryAfter: true },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(await client.fetchJson('GET', '/x')).toEqual({ ok: true });
    expect(sleeps).toEqual([3000]);
  });

  it('caps the honored delay at maxRetryAfterMs', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(503, {}, { 'retry-after': '600' }))
      .mockResolvedValueOnce(jsonRes(200, { ok: 1 }));
    const client = createApiClient({
      baseUrl: 'https://api.test',
      retry: {
        count: 1,
        delayMs: 2000,
        statuses: [429, 503],
        honorRetryAfter: true,
        maxRetryAfterMs: 5000,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await client.fetchJson('GET', '/x');
    expect(sleeps).toEqual([5000]);
  });

  it('falls back to delayMs when the header is absent', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(429, {}))
      .mockResolvedValueOnce(jsonRes(200, { ok: 1 }));
    const client = createApiClient({
      baseUrl: 'https://api.test',
      retry: { count: 1, delayMs: 1500, honorRetryAfter: true },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await client.fetchJson('GET', '/x');
    expect(sleeps).toEqual([1500]);
  });

  it('keeps the historical fixed-delay behavior when honorRetryAfter is off', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(429, {}, { 'retry-after': '9' }))
      .mockResolvedValueOnce(jsonRes(200, { ok: 1 }));
    const client = createApiClient({
      baseUrl: 'https://api.test',
      retry: { count: 1, delayMs: 2000 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await client.fetchJson('GET', '/x');
    expect(sleeps).toEqual([2000]);
  });
});
