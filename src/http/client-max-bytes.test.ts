import { describe, expect, it, vi } from 'vitest';

import { McpToolError, MCP_TOOL_ERROR_KINDS, errorKindOf } from '../errors/index.js';
import {
  ApiError,
  createApiClient,
  RequestTimeoutError,
  ResponseTooLargeError,
  WriteOutcomeUnknownError,
} from './index.js';

/**
 * fleet-audit #733 (splitwise-mcp BUG-2, fleet-shared): `fetchRaw` buffered
 * the whole body with `res.arrayBuffer()` and no size cap, so a very large
 * receipt download ballooned memory in the stdio server. The body-read
 * deadline already landed (#361); these pin the byte cap — per request
 * (`maxBytes`) and as a client default (`maxResponseBytes`, unlimited unless
 * set), shared with `fetchBounded`'s `maxBytes`.
 */

const BASE = 'https://api.test';

/** A body that yields `chunk`-sized pieces forever, counting pulls and cancels. */
function endless(chunk = 400): { body: ReadableStream<Uint8Array>; pulls: () => number; cancel: ReturnType<typeof vi.fn> } {
  let pulls = 0;
  const cancel = vi.fn(async () => {});
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel,
  });
  return { body, pulls: () => pulls, cancel };
}

const fetchOf = (make: () => Response): typeof fetch => (async () => make()) as unknown as typeof fetch;

describe('createApiClient maxBytes — Content-Length', () => {
  it('fetchRaw refuses a declared Content-Length over the cap before reading', async () => {
    let pulls = 0;
    const cancel = vi.fn(async () => {});
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulls++;
      },
      cancel,
    });
    const client = createApiClient({
      baseUrl: BASE,
      serviceName: 'Receipts',
      fetchImpl: fetchOf(() => new Response(body, { headers: { 'content-length': '2000' } })),
    });
    const p = client.fetchRaw('GET', '/receipt', { maxBytes: 1000 });
    await expect(p).rejects.toBeInstanceOf(ResponseTooLargeError);
    await expect(p).rejects.toMatchObject({ maxBytes: 1000, kind: 'too_large' });
    await expect(p).rejects.toThrow(/Receipts.*1000/);
    expect(cancel).toHaveBeenCalled();
    // `start` pulls once to fill the queue; nothing beyond that was read.
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it('fetchJson and fetchHtml honour the cap too', async () => {
    const big = 'x'.repeat(50);
    const client = createApiClient({
      baseUrl: BASE,
      fetchImpl: fetchOf(() => new Response(JSON.stringify(big), { headers: { 'content-type': 'application/json' } })),
    });
    await expect(client.fetchJson('GET', '/j', { maxBytes: 10 })).rejects.toBeInstanceOf(ResponseTooLargeError);
    await expect(client.fetchHtml('GET', '/h', { maxBytes: 10 })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});

describe('createApiClient maxBytes — streaming', () => {
  it('rejects a chunked body mid-stream and cancels the reader', async () => {
    const src = endless(400);
    const client = createApiClient({ baseUrl: BASE, fetchImpl: fetchOf(() => new Response(src.body)) });
    await expect(client.fetchRaw('GET', '/big', { maxBytes: 1000 })).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(src.pulls()).toBeLessThan(10);
    expect(src.cancel).toHaveBeenCalled();
  });

  it('a body under the cap passes, byte for byte', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const client = createApiClient({
      baseUrl: BASE,
      fetchImpl: fetchOf(() => new Response(bytes, { headers: { 'content-type': 'image/png' } })),
    });
    const raw = await client.fetchRaw('GET', '/img', { maxBytes: 5 });
    expect([...raw.bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(raw.contentType).toBe('image/png');
  });

  it('fetchJson parses and fetchHtml decodes a body under the cap', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      fetchImpl: fetchOf(() => new Response('{"ok":"é"}', { headers: { 'content-type': 'application/json' } })),
    });
    expect(await client.fetchJson('GET', '/j', { maxBytes: 100 })).toEqual({ ok: 'é' });
    expect(await client.fetchHtml('GET', '/h', { maxBytes: 100 })).toBe('{"ok":"é"}');
  });

  it('an empty / null body under a cap is empty, and a 204 is still undefined', async () => {
    const client = createApiClient({ baseUrl: BASE, fetchImpl: fetchOf(() => new Response(null, { status: 200 })) });
    expect((await client.fetchRaw('GET', '/e', { maxBytes: 10 })).bytes.byteLength).toBe(0);
    expect(await client.fetchJson('GET', '/e', { maxBytes: 10 })).toBeUndefined();
  });

  it('the timeout still covers a capped stream that stalls', async () => {
    const cancel = vi.fn(async () => {});
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(10));
        }
        // then never again: the body stalls under the cap
        return new Promise(() => {});
      },
      cancel,
    });
    const client = createApiClient({ baseUrl: BASE, timeout: 30, fetchImpl: fetchOf(() => new Response(body)) });
    await expect(client.fetchRaw('GET', '/slow', { maxBytes: 1_000_000 })).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(cancel).toHaveBeenCalled();
  });
});

describe('createApiClient maxResponseBytes — client default', () => {
  it('is unlimited unless set', async () => {
    const big = new Uint8Array(256 * 1024);
    const client = createApiClient({ baseUrl: BASE, fetchImpl: fetchOf(() => new Response(big)) });
    expect((await client.fetchRaw('GET', '/big')).bytes.byteLength).toBe(big.byteLength);
  });

  it('applies to every call that names no maxBytes', async () => {
    const src = endless(400);
    const client = createApiClient({
      baseUrl: BASE,
      maxResponseBytes: 1000,
      fetchImpl: fetchOf(() => new Response(src.body)),
    });
    await expect(client.fetchRaw('GET', '/big')).rejects.toMatchObject({ maxBytes: 1000 });
    expect(src.cancel).toHaveBeenCalled();
  });

  it('a per-request maxBytes overrides the default, either way', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      maxResponseBytes: 4,
      fetchImpl: fetchOf(() => new Response('123456')),
    });
    await expect(client.fetchHtml('GET', '/x')).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(await client.fetchHtml('GET', '/x', { maxBytes: 6 })).toBe('123456');
    await expect(client.fetchHtml('GET', '/x', { maxBytes: 5 })).rejects.toMatchObject({ maxBytes: 5 });
  });

  it('refuses a cap that is not a non-negative number', async () => {
    for (const bad of [NaN, -1, Infinity * -1]) {
      expect(() => createApiClient({ baseUrl: BASE, maxResponseBytes: bad })).toThrow(TypeError);
    }
    const client = createApiClient({ baseUrl: BASE, fetchImpl: fetchOf(() => new Response('x')) });
    await expect(client.fetchRaw('GET', '/x', { maxBytes: NaN })).rejects.toThrow(TypeError);
  });
});

describe('ResponseTooLargeError', () => {
  it('is an McpToolError of kind too_large that never echoes the body', async () => {
    const secret = 'Bearer abc.def.ghi SECRET-BODY';
    const client = createApiClient({ baseUrl: BASE, serviceName: 'Svc', fetchImpl: fetchOf(() => new Response(secret)) });
    const err = await client.fetchHtml('GET', '/x', { maxBytes: 3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect((err as ResponseTooLargeError).name).toBe('ResponseTooLargeError');
    expect(errorKindOf(err)).toBe('too_large');
    expect((err as Error).message).not.toContain('SECRET');
    expect((err as McpToolError).hint).toMatch(/maxBytes/);
    expect(MCP_TOOL_ERROR_KINDS.has('too_large')).toBe(true);
  });

  it('a write whose response is too large is not reported as outcome-unknown', async () => {
    const client = createApiClient({ baseUrl: BASE, fetchImpl: fetchOf(() => new Response('123456')) });
    const err = await client.fetchJson('POST', '/send', { body: {}, maxBytes: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it('an over-cap ERROR body still reports the HTTP status, with the body dropped', async () => {
    const client = createApiClient({
      baseUrl: BASE,
      fetchImpl: fetchOf(() => new Response('server exploded '.repeat(10), { status: 500 })),
    });
    for (const call of [
      () => client.fetchRaw('GET', '/x', { maxBytes: 5 }),
      () => client.fetchJson('GET', '/x', { maxBytes: 5 }),
      () => client.fetchHtml('GET', '/x', { maxBytes: 5 }),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as Error).message).not.toContain('exploded');
    }
  });
});
