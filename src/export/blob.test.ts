import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { McpToolError } from '../errors/index.js';
import {
  blobStoreFromEnv,
  createBlobStore,
  BLOB_DEFAULT_TTL_MS,
  BLOB_MAX_OBJECT_BYTES,
  BLOB_MAX_TTL_MS,
} from './blob.js';
import { ResponseTooLargeError } from '../http/index.js';

const BASE = 'https://mcp.example.com/b/reg-1234';
const KEY = 'test-signing-key-0123456789';
const ENV = { MCP_BLOB_BASE_URL: BASE, MCP_BLOB_SIGNING_KEY: KEY };
const NOW = 1_767_225_600_000 - BLOB_DEFAULT_TTL_MS; // so exp === 1767225600000

/** Independent HMAC, computed here rather than through the module under test. */
const hmac = (payload: string) => createHmac('sha256', KEY).update(payload).digest('base64url');

function parse(url: string) {
  const u = new URL(url);
  return { u, exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') };
}

describe('blobStoreFromEnv', () => {
  it('returns undefined when either variable is missing (a stdio install)', () => {
    expect(blobStoreFromEnv({})).toBeUndefined();
    expect(blobStoreFromEnv({ MCP_BLOB_BASE_URL: BASE })).toBeUndefined();
    expect(blobStoreFromEnv({ MCP_BLOB_SIGNING_KEY: KEY })).toBeUndefined();
  });

  it('treats placeholder / null values as unset (readEnvVar hardening)', () => {
    expect(blobStoreFromEnv({ MCP_BLOB_BASE_URL: '${MCP_BLOB_BASE_URL}', MCP_BLOB_SIGNING_KEY: KEY })).toBeUndefined();
    expect(blobStoreFromEnv({ MCP_BLOB_BASE_URL: BASE, MCP_BLOB_SIGNING_KEY: 'null' })).toBeUndefined();
  });

  it('defaults to process.env', () => {
    vi.stubEnv('MCP_BLOB_BASE_URL', BASE);
    vi.stubEnv('MCP_BLOB_SIGNING_KEY', KEY);
    try {
      expect(blobStoreFromEnv()?.prefix).toBe('reg-1234');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('derives the prefix by stripping the leading b/ from the base path', () => {
    const store = blobStoreFromEnv(ENV)!;
    expect(store.prefix).toBe('reg-1234');
    expect(store.baseUrl).toBe(BASE);
    expect(blobStoreFromEnv({ ...ENV, MCP_BLOB_BASE_URL: `${BASE}/` })!.baseUrl).toBe(BASE);
  });

  it('throws a clear McpToolError on a malformed base URL without echoing it', () => {
    const bad = 'not a url user:hunter2';
    let err: unknown;
    try {
      blobStoreFromEnv({ ...ENV, MCP_BLOB_BASE_URL: bad });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/MCP_BLOB_BASE_URL/);
    expect((err as Error).message).not.toContain('hunter2');
  });

  it('rejects a base URL with no registration path, a query, credentials or a non-http scheme', () => {
    for (const b of [
      'https://mcp.example.com',
      'https://mcp.example.com/b/',
      `${BASE}?x=1`,
      'https://u:p@mcp.example.com/b/reg-1234',
      'ftp://mcp.example.com/b/reg-1234',
    ]) {
      expect(() => blobStoreFromEnv({ ...ENV, MCP_BLOB_BASE_URL: b }), b).toThrow(McpToolError);
    }
  });
});

describe('signGetUrl', () => {
  const store = createBlobStore({ baseUrl: BASE, signingKey: KEY });

  it('signs `<prefix>/<key>\\n<exp>` with HMAC-SHA256 base64url', () => {
    const { url, expiresAtMs } = store.signGetUrl('exp/abc123/part-0001.zip', { now: NOW });
    const { u, exp, sig } = parse(url);
    expect(expiresAtMs).toBe(1_767_225_600_000);
    expect(exp).toBe('1767225600000');
    expect(u.origin + u.pathname).toBe(`${BASE}/exp/abc123/part-0001.zip`);
    expect(sig).toBe(hmac(`reg-1234/exp/abc123/part-0001.zip\n1767225600000`));
  });

  it('matches splitwise-mcp _blob.ts output byte for byte (cross-checked vector)', () => {
    // Produced by running ~/git/splitwise-mcp/src/tools/_blob.ts signedGetUrl with
    // the same base, key, object key and exp.
    expect(store.signGetUrl('exp/abc123/part-0001.zip', { now: NOW }).url).toBe(
      'https://mcp.example.com/b/reg-1234/exp/abc123/part-0001.zip?exp=1767225600000&sig=9HkuOdC2paxUhA2FTNnr07J62HGn8l8VHyI6l_cZVM0',
    );
  });

  it('defaults the TTL to 1h from Date.now()', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    try {
      expect(store.signGetUrl('a.txt').expiresAtMs).toBe(5_000_000 + 60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a TTL up to 24h and refuses anything longer or non-positive', () => {
    expect(store.signGetUrl('a.txt', { now: 0, ttlMs: BLOB_MAX_TTL_MS }).expiresAtMs).toBe(24 * 60 * 60 * 1000);
    expect(() => store.signGetUrl('a.txt', { ttlMs: BLOB_MAX_TTL_MS + 1 })).toThrow(McpToolError);
    expect(() => store.signGetUrl('a.txt', { ttlMs: 0 })).toThrow(McpToolError);
    expect(() => store.signGetUrl('a.txt', { ttlMs: Number.NaN })).toThrow(McpToolError);
  });
});

describe('signPutUrl', () => {
  const store = createBlobStore({ baseUrl: BASE, signingKey: KEY });

  it('signs `put\\0<prefix>/<key>\\0<contentType>\\0<exp>`', () => {
    const { url } = store.signPutUrl('exp/abc123/part-0001.zip', 'application/zip', { now: NOW });
    const { exp, sig } = parse(url);
    expect(exp).toBe('1767225600000');
    expect(sig).toBe(hmac(`put\x00reg-1234/exp/abc123/part-0001.zip\x00application/zip\x001767225600000`));
  });

  it('matches splitwise-mcp _blob.ts output byte for byte (cross-checked vector)', () => {
    expect(store.signPutUrl('exp/abc123/part-0001.zip', 'application/zip', { now: NOW }).url).toBe(
      'https://mcp.example.com/b/reg-1234/exp/abc123/part-0001.zip?exp=1767225600000&sig=jvSFMDAWfs7PZQI_zpY3TjMEnkPHcf1RUMw49-xOrKc',
    );
  });

  it('a read signature is never a write signature', () => {
    const g = parse(store.signGetUrl('k.zip', { now: NOW }).url).sig;
    const p = parse(store.signPutUrl('k.zip', 'application/zip', { now: NOW }).url).sig;
    expect(g).not.toBe(p);
  });

  it('refuses an empty or control-character content type', () => {
    expect(() => store.signPutUrl('k.zip', '', { now: NOW })).toThrow(McpToolError);
    expect(() => store.signPutUrl('k.zip', 'text/plain\0x', { now: NOW })).toThrow(McpToolError);
    expect(() => store.signPutUrl('k.zip', 'text/plain\n', { now: NOW })).toThrow(McpToolError);
  });
});

describe('key validation', () => {
  const store = createBlobStore({ baseUrl: BASE, signingKey: KEY });

  it.each([
    ['', 'empty'],
    ['/abs/key', 'leading slash'],
    ['a/../b', 'dot-dot segment'],
    ['..', 'bare dot-dot'],
    ['a/./b', 'dot segment'],
    ['a//b', 'empty segment'],
    ['a/b/', 'trailing slash'],
    ['a\\b', 'backslash'],
    ['a b', 'space'],
    ['a?b', 'query char'],
    ['a#b', 'hash'],
    ['a%2e%2e', 'percent'],
    ['café', 'non-ascii'],
    ['x'.repeat(1025), 'too long'],
  ])('refuses %j (%s)', (key) => {
    expect(() => store.signGetUrl(key)).toThrow(McpToolError);
    expect(() => store.signPutUrl(key, 'text/plain')).toThrow(McpToolError);
  });

  it('accepts safe characters and encodes each segment', () => {
    const { url } = store.signGetUrl('exp/A-b_c.9~/part-0001.jsonl', { now: NOW });
    expect(new URL(url).pathname).toBe('/b/reg-1234/exp/A-b_c.9~/part-0001.jsonl');
  });
});

describe('put', () => {
  const store = createBlobStore({ baseUrl: BASE, signingKey: KEY });

  it('PUTs the bytes to a signed URL with the content-type header', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const res = await store.put('exp/x/part-0001.zip', bytes, 'application/zip', { fetchImpl, now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('content-type')).toBe('application/zip');
    const { sig, exp } = parse(url);
    expect(sig).toBe(hmac(`put\x00reg-1234/exp/x/part-0001.zip\x00application/zip\x00${exp}`));
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
    expect(res).toEqual({ key: 'exp/x/part-0001.zip', bytes: 4 });
  });

  it('PUTs a string as UTF-8 and reports its byte length', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const res = await store.put('a.md', 'hé', 'text/markdown', { fetchImpl });
    expect(res.bytes).toBe(3);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new TextDecoder().decode(new Uint8Array(init.body as ArrayBuffer))).toBe('hé');
  });

  // fleet-audit#1441: an archive is the whole part; copying it again to PUT
  // it doubled peak memory for nothing when the view already IS its buffer.
  it('PUTs a view that spans its whole buffer without copying it', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.put('whole.bin', bytes, 'application/octet-stream', { fetchImpl });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe(bytes.buffer);
  });

  it('PUTs a Uint8Array view at its own offset only', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const backing = new Uint8Array([9, 9, 1, 2, 9]);
    await store.put('v.bin', backing.subarray(2, 4), 'application/octet-stream', { fetchImpl });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2]));
  });

  it('throws McpToolError with the status on a non-2xx, never echoing the signature or key', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 403 }));
    let err: unknown;
    try {
      await store.put('k.zip', new Uint8Array([1]), 'application/zip', { fetchImpl, now: NOW });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).status).toBe(403);
    expect((err as McpToolError).kind).toBe('http');
    const sig = hmac(`put\x00reg-1234/k.zip\x00application/zip\x00${NOW + BLOB_DEFAULT_TTL_MS}`);
    expect((err as Error).message).not.toContain(sig);
    expect((err as Error).message).not.toContain('sig=');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('wraps a network failure as a transport McpToolError without the URL', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      throw new TypeError(`fetch failed for ${url}`);
    });
    let err: unknown;
    try {
      await store.put('k.zip', 'x', 'text/plain', { fetchImpl: fetchImpl as unknown as typeof fetch });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('transport');
    expect((err as Error).message).not.toContain('sig=');
  });

  it('validates the key before any network call', async () => {
    const fetchImpl = vi.fn();
    await expect(store.put('../x', 'x', 'text/plain', { fetchImpl })).rejects.toBeInstanceOf(McpToolError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes an abort signal through', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const ac = new AbortController();
    await store.put('k.txt', 'x', 'text/plain', { fetchImpl, signal: ac.signal });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBe(ac.signal);
  });
});

describe('signDeleteUrl', () => {
  const store = createBlobStore({ baseUrl: BASE, signingKey: KEY });

  it('signs `del\\0<prefix>/<key>\\0<exp>` (the gateway deletePayload shape)', () => {
    const { url, expiresAtMs } = store.signDeleteUrl('up/abc/photo.jpg', { now: NOW });
    const { u, exp, sig } = parse(url);
    expect(expiresAtMs).toBe(1_767_225_600_000);
    expect(u.origin + u.pathname).toBe(`${BASE}/up/abc/photo.jpg`);
    expect(sig).toBe(hmac(`del\x00reg-1234/up/abc/photo.jpg\x00${exp}`));
  });

  it('never verifies as a read or a write signature, and vice versa', () => {
    const del = parse(store.signDeleteUrl('k.bin', { now: NOW }).url).sig;
    const get = parse(store.signGetUrl('k.bin', { now: NOW }).url).sig;
    const put = parse(store.signPutUrl('k.bin', 'application/octet-stream', { now: NOW }).url).sig;
    expect(new Set([del, get, put]).size).toBe(3);
  });

  it('validates the key and TTL like the other verbs', () => {
    expect(() => store.signDeleteUrl('../x')).toThrow(McpToolError);
    expect(() => store.signDeleteUrl('x', { ttlMs: BLOB_MAX_TTL_MS + 1 })).toThrow(McpToolError);
  });
});

describe('delete', () => {
  const store = createBlobStore({ baseUrl: BASE, signingKey: KEY });

  it('sends DELETE to a delete-signed URL and resolves on 204', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await store.delete('up/abc/photo.jpg', { fetchImpl, now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    const { sig, exp } = parse(url);
    expect(sig).toBe(hmac(`del\x00reg-1234/up/abc/photo.jpg\x00${exp}`));
  });

  it('throws an http McpToolError on a non-2xx without the signature', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"bad signature"}', { status: 403 }));
    const err = await store.delete('k.bin', { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('http');
    expect((err as McpToolError).status).toBe(403);
    expect((err as Error).message).not.toContain('sig=');
  });

  it('wraps a network failure as a transport McpToolError without the URL', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      throw new TypeError(`fetch failed for ${url}`);
    });
    const err = await store
      .delete('k.bin', { fetchImpl: fetchImpl as unknown as typeof fetch })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('transport');
    expect((err as Error).message).not.toContain('sig=');
  });

  it('rethrows the caller\'s own cancellation unchanged', async () => {
    const ac = new AbortController();
    ac.abort(new Error('user cancelled'));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(store.delete('k.bin', { fetchImpl, signal: ac.signal })).rejects.toThrow('user cancelled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates the key before any network call', async () => {
    const fetchImpl = vi.fn();
    await expect(store.delete('a//b', { fetchImpl })).rejects.toBeInstanceOf(McpToolError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('get', () => {
  const store = createBlobStore({ baseUrl: BASE, signingKey: KEY });

  it('GETs a read-signed URL and returns the bytes and the stored content type', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
    const obj = await store.get('up/abc/photo.jpg', { fetchImpl, now: NOW });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('GET');
    const { sig, exp } = parse(url);
    expect(sig).toBe(hmac(`reg-1234/up/abc/photo.jpg\n${exp}`));
    expect(obj).toEqual({ key: 'up/abc/photo.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' });
  });

  it('reports a missing content type as undefined', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    // A Response built from bytes carries no content-type of its own.
    expect((await store.get('k.bin', { fetchImpl })).contentType).toBeUndefined();
  });

  it('names a 404 as missing, expired or already consumed', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"not found"}', { status: 404 }));
    const err = await store.get('k.bin', { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).status).toBe(404);
    expect((err as Error).message).toMatch(/not found/i);
    expect((err as Error).message).not.toContain('sig=');
  });

  it('enforces maxBytes, defaulting to the gateway object cap', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(10), { status: 200 }));
    await expect(store.get('k.bin', { fetchImpl, maxBytes: 4 })).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(BLOB_MAX_OBJECT_BYTES).toBe(100 * 1024 * 1024);
    const big = vi.fn(
      async () => new Response(new Uint8Array(1), { status: 200, headers: { 'content-length': String(BLOB_MAX_OBJECT_BYTES + 1) } }),
    );
    await expect(store.get('k.bin', { fetchImpl: big })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('wraps a network failure as a transport McpToolError without the URL', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      throw new TypeError(`fetch failed for ${url}`);
    });
    const err = await store.get('k.bin', { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e: unknown) => e);
    expect((err as McpToolError).kind).toBe('transport');
    expect((err as Error).message).not.toContain('sig=');
  });
});

describe('consume', () => {
  const store = createBlobStore({ baseUrl: BASE, signingKey: KEY });

  /** A fetch that serves one object and records every call. */
  function fakeStore(opts: { getStatus?: number; deleteStatus?: number; deleteThrows?: boolean } = {}) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        if (opts.deleteThrows) throw new TypeError('socket hang up');
        return new Response(null, { status: opts.deleteStatus ?? 204 });
      }
      return new Response(new Uint8Array([7, 7]), {
        status: opts.getStatus ?? 200,
        headers: { 'content-type': 'image/png' },
      });
    });
  }
  const methods = (f: ReturnType<typeof fakeStore>) =>
    f.mock.calls.map((c) => (c[1] as RequestInit | undefined)?.method);

  it('reads the object, hands it to `use`, then deletes it', async () => {
    const fetchImpl = fakeStore();
    const use = vi.fn(async (obj: { bytes: Uint8Array; contentType?: string }) => {
      expect(obj.bytes).toEqual(new Uint8Array([7, 7]));
      expect(obj.contentType).toBe('image/png');
      // Not deleted while it is still in use.
      expect(methods(fetchImpl)).toEqual(['GET']);
      return { fileId: 42 };
    });
    const out = await store.consume('up/a/p.png', use, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({ result: { fileId: 42 }, deleted: true });
    expect(methods(fetchImpl)).toEqual(['GET', 'DELETE']);
  });

  it('keeps the object when `use` throws, and rethrows its error', async () => {
    const fetchImpl = fakeStore();
    await expect(
      store.consume('k.png', async () => {
        throw new Error('OFW rejected the upload');
      }, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('OFW rejected the upload');
    expect(methods(fetchImpl)).toEqual(['GET']);
  });

  it('never calls `use` or deletes when the read fails', async () => {
    const fetchImpl = fakeStore({ getStatus: 404 });
    const use = vi.fn();
    await expect(store.consume('k.png', use, { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(
      McpToolError,
    );
    expect(use).not.toHaveBeenCalled();
    expect(methods(fetchImpl)).toEqual(['GET']);
  });

  // The consumer's side effect has HAPPENED. Throwing now would read as "the
  // upload failed" and invite a retry that duplicates it — so a failed delete
  // is reported beside the result, never in place of it.
  it('reports a failed delete beside the result instead of throwing', async () => {
    for (const fetchImpl of [fakeStore({ deleteStatus: 500 }), fakeStore({ deleteThrows: true })]) {
      const out = await store.consume('k.png', async () => 'ok', { fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(out.result).toBe('ok');
      expect(out.deleted).toBe(false);
      expect(out.deleteError).toMatch(/k\.png/);
      expect(out.deleteError).not.toContain('sig=');
    }
  });

  it('passes maxBytes through to the read', async () => {
    const fetchImpl = fakeStore();
    const use = vi.fn();
    await expect(
      store.consume('k.png', use, { fetchImpl: fetchImpl as unknown as typeof fetch, maxBytes: 1 }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(use).not.toHaveBeenCalled();
  });
});
