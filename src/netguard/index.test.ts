import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { request } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RedirectRefusedError, RequestTimeoutError, ResponseTooLargeError, UrlNotAllowedError } from '../http/index.js';
import { createPublicOnlyDispatcher, fetchPublic, isPublicAddress, type Resolver } from './index.js';

// ---------------------------------------------------------------------------
// isPublicAddress
// ---------------------------------------------------------------------------

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '100.63.255.255', // just below CGNAT
    '100.128.0.0', // just above CGNAT
    '172.15.255.255',
    '172.32.0.0',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8', // mapped, public payload
    '::ffff:808:808', // mapped, hex spelling
    '64:ff9b::808:808', // NAT64 of a public v4
    '2002:808:808::1', // 6to4 of a public v4
  ])('%s is public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    // IPv4
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'RFC 1918'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.255', 'CGNAT top'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['172.16.0.1', 'RFC 1918'],
    ['172.31.255.255', 'RFC 1918'],
    ['192.0.0.8', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['192.88.99.1', '6to4 relay anycast'],
    ['192.168.1.1', 'RFC 1918'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.7', 'TEST-NET-2'],
    ['203.0.113.9', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    // IPv6
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::127.0.0.1', 'IPv4-compatible (deprecated) — refused whole'],
    ['::8.8.8.8', 'IPv4-compatible with a public payload — still refused'],
    ['::ffff:127.0.0.1', 'mapped loopback'],
    ['::ffff:7f00:1', 'mapped loopback, hex'],
    ['::ffff:169.254.169.254', 'mapped metadata'],
    ['::ffff:a9fe:a9fe', 'mapped metadata, hex'],
    ['::ffff:0:a00:1', 'SIIT-translated 10.0.0.1'],
    ['64:ff9b::a00:1', 'NAT64 of 10.0.0.1'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['2002:a00:1::1', '6to4 of 10.0.0.1'],
    ['2002:a9fe:a9fe::', '6to4 of the metadata address'],
    ['100::1', 'discard-only'],
    ['2001::1', 'Teredo'],
    ['2001:2::1', 'benchmarking'],
    ['2001:10::1', 'ORCHID'],
    ['2001:20::1', 'ORCHIDv2'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation (2024)'],
    ['5f00::1', 'SRv6 SIDs'],
    ['fc00::1', 'ULA'],
    ['fdaa:0:1::2', 'ULA (Fly 6PN)'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local top'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
  ])('%s is not public (%s)', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    '',
    'localhost',
    'example.com',
    '127.1', // shorthand — never a resolver answer; fail closed
    '0x7f.0.0.1',
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '[::1]', // bracketed URL form is not an address
    'fe80::1%eth0', // zone id
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    ':::',
    '12345::',
    '1:2:3:4:5:6:7::8', // '::' must stand for at least one group
    '::ffff:1.2.3.999',
    'g::1',
  ])('fails closed on %j', (text) => {
    expect(isPublicAddress(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A local server that stands in for "the internet"
// ---------------------------------------------------------------------------

/**
 * 127.0.0.1 stands in for a public host in these tests: the dispatcher is
 * built with an address predicate that admits it alongside every genuinely
 * public address, so a request can complete against a local server while every
 * private range stays refused.
 */
const LOOPBACK_AS_PUBLIC = (ip: string): boolean => ip === '127.0.0.1' || isPublicAddress(ip);

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let port: number;
let hits: { url: string; host: string; method: string; headers: IncomingMessage['headers'] }[];
let handler: Handler;

beforeEach(async () => {
  hits = [];
  handler = (_req, res) => {
    res.end('ok');
  };
  server = createServer((req, res) => {
    hits.push({ url: req.url ?? '', host: req.headers.host ?? '', method: req.method ?? '', headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** A resolver answering from a fixed table, counting how often it was asked. */
function table(map: Record<string, string[] | (() => string[])>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (hostname: string) => {
    calls.push(hostname);
    const entry = map[hostname];
    if (entry === undefined) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return typeof entry === 'function' ? entry() : entry;
  }) as Resolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** Walks a cause chain looking for an instance of `cls`. */
function findInChain<T>(err: unknown, cls: new (...args: never[]) => T): T | undefined {
  let e: unknown = err;
  for (let i = 0; i < 8 && e; i += 1) {
    if (e instanceof cls) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// createPublicOnlyDispatcher
// ---------------------------------------------------------------------------

describe('createPublicOnlyDispatcher', () => {
  it('connects to the vetted address for a name that resolves publicly', async () => {
    const resolve = table({ 'svc.test': ['127.0.0.1'] });
    const dispatcher = createPublicOnlyDispatcher({ resolve, isAllowedAddress: LOOPBACK_AS_PUBLIC });
    try {
      const res = await request(`http://svc.test:${port}/hello`, { dispatcher });
      expect(res.statusCode).toBe(200);
      expect(await res.body.text()).toBe('ok');
      expect(hits).toEqual([expect.objectContaining({ url: '/hello', host: `svc.test:${port}` })]);
      expect(resolve.calls).toEqual(['svc.test']);
    } finally {
      await dispatcher.destroy();
    }
  });

  it('refuses an IP-literal host that is not public, without connecting', async () => {
    const resolve = table({});
    const dispatcher = createPublicOnlyDispatcher({ resolve });
    try {
      const err = await request(`http://127.0.0.1:${port}/`, { dispatcher }).catch((e: unknown) => e);
      expect(findInChain(err, UrlNotAllowedError)).toBeInstanceOf(UrlNotAllowedError);
      const meta = await request('http://169.254.169.254/latest/meta-data/', { dispatcher }).catch((e: unknown) => e);
      expect(findInChain(meta, UrlNotAllowedError)?.reason).toBe('host');
      const v6 = await request(`http://[::1]:${port}/`, { dispatcher }).catch((e: unknown) => e);
      expect(findInChain(v6, UrlNotAllowedError)).toBeInstanceOf(UrlNotAllowedError);
      expect(hits).toEqual([]);
      expect(resolve.calls).toEqual([]); // a literal is judged, never resolved
    } finally {
      await dispatcher.destroy();
    }
  });

  it('admits an IP-literal host the predicate allows', async () => {
    const dispatcher = createPublicOnlyDispatcher({ resolve: table({}), isAllowedAddress: LOOPBACK_AS_PUBLIC });
    try {
      const res = await request(`http://127.0.0.1:${port}/lit`, { dispatcher });
      expect(res.statusCode).toBe(200);
      await res.body.dump();
    } finally {
      await dispatcher.destroy();
    }
  });

  it('refuses a name that resolves to the cloud metadata address', async () => {
    const resolve = table({ 'meta.test': ['169.254.169.254'] });
    const dispatcher = createPublicOnlyDispatcher({ resolve, isAllowedAddress: LOOPBACK_AS_PUBLIC });
    try {
      const err = await request(`http://meta.test:${port}/`, { dispatcher }).catch((e: unknown) => e);
      const refused = findInChain(err, UrlNotAllowedError);
      expect(refused).toBeInstanceOf(UrlNotAllowedError);
      expect(refused?.message).toContain('meta.test');
      expect(refused?.message).not.toContain('169.254'); // names the host, not what it resolved to
      expect(hits).toEqual([]);
    } finally {
      await dispatcher.destroy();
    }
  });

  it('refuses a name when ANY of its addresses is not public', async () => {
    const resolve = table({ 'mixed.test': ['127.0.0.1', '10.0.0.5'] });
    const dispatcher = createPublicOnlyDispatcher({ resolve, isAllowedAddress: LOOPBACK_AS_PUBLIC });
    try {
      const err = await request(`http://mixed.test:${port}/`, { dispatcher }).catch((e: unknown) => e);
      expect(findInChain(err, UrlNotAllowedError)).toBeInstanceOf(UrlNotAllowedError);
      expect(hits).toEqual([]);
    } finally {
      await dispatcher.destroy();
    }
  });

  it('refuses a name that resolves to nothing', async () => {
    const dispatcher = createPublicOnlyDispatcher({ resolve: table({ 'empty.test': [] }) });
    try {
      const err = await request(`http://empty.test:${port}/`, { dispatcher }).catch((e: unknown) => e);
      expect(findInChain(err, UrlNotAllowedError)).toBeInstanceOf(UrlNotAllowedError);
    } finally {
      await dispatcher.destroy();
    }
  });

  it('passes a resolver failure through as the connect error', async () => {
    const dispatcher = createPublicOnlyDispatcher({ resolve: table({}) });
    try {
      const err = await request(`http://nowhere.test:${port}/`, { dispatcher }).catch((e: unknown) => e);
      expect(findInChain(err, UrlNotAllowedError)).toBeUndefined();
      expect(String((err as Error).message)).toMatch(/ENOTFOUND/);
    } finally {
      await dispatcher.destroy();
    }
  });

  it('refuses a rebinding name at CONNECT time: public on one lookup, private on the next', async () => {
    // Every connection resolves afresh and is judged on what IT resolved; the
    // server closes after each response so the second request must reconnect.
    handler = (_req, res) => {
      res.setHeader('connection', 'close');
      res.end('first');
    };
    let n = 0;
    const resolve = table({ 'rebind.test': () => (n++ === 0 ? ['127.0.0.1'] : ['169.254.169.254']) });
    const dispatcher = createPublicOnlyDispatcher({ resolve, isAllowedAddress: LOOPBACK_AS_PUBLIC });
    try {
      const first = await request(`http://rebind.test:${port}/a`, { dispatcher });
      expect(await first.body.text()).toBe('first');
      const err = await request(`http://rebind.test:${port}/b`, { dispatcher }).catch((e: unknown) => e);
      expect(findInChain(err, UrlNotAllowedError)).toBeInstanceOf(UrlNotAllowedError);
      expect(hits.map((h) => h.url)).toEqual(['/a']);
      expect(resolve.calls).toEqual(['rebind.test', 'rebind.test']);
    } finally {
      await dispatcher.destroy();
    }
  });

  it('serves a single-address lookup too (autoSelectFamily off), picking the vetted address', async () => {
    const resolve = table({ 'svc.test': ['127.0.0.1'] });
    const dispatcher = createPublicOnlyDispatcher({
      resolve,
      isAllowedAddress: LOOPBACK_AS_PUBLIC,
      connect: { autoSelectFamily: false },
    });
    try {
      const res = await request(`http://svc.test:${port}/single`, { dispatcher });
      expect(res.statusCode).toBe(200);
      await res.body.dump();
      expect(hits.map((h) => h.url)).toEqual(['/single']);
    } finally {
      await dispatcher.destroy();
    }
  });

  it('defaults to the system resolver (localhost resolves to loopback and is refused)', async () => {
    const dispatcher = createPublicOnlyDispatcher();
    try {
      const err = await request(`http://localhost:${port}/`, { dispatcher }).catch((e: unknown) => e);
      expect(findInChain(err, UrlNotAllowedError)).toBeInstanceOf(UrlNotAllowedError);
      expect(hits).toEqual([]);
    } finally {
      await dispatcher.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// fetchPublic
// ---------------------------------------------------------------------------

describe('fetchPublic', () => {
  const opts = (resolve: Resolver) => ({ resolve, isAllowedAddress: LOOPBACK_AS_PUBLIC, requireHttps: false });

  it('fetches a public URL and returns the body, status and headers', async () => {
    handler = (_req, res) => {
      res.setHeader('x-kind', 'test');
      res.end('payload');
    };
    const r = await fetchPublic(`http://svc.test:${port}/x`, opts(table({ 'svc.test': ['127.0.0.1'] })));
    expect(r.stopped).toBe(false);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-kind')).toBe('test');
    expect(new TextDecoder().decode(r.body)).toBe('payload');
    expect(r.url).toBe(`http://svc.test:${port}/x`);
    expect(r.hops).toBe(0);
  });

  it('refuses an IP-literal URL to a private address', async () => {
    const err = await fetchPublic('http://169.254.169.254/latest/meta-data/', { requireHttps: false }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UrlNotAllowedError);
  });

  it('refuses a name that resolves to 169.254.169.254', async () => {
    const err = await fetchPublic(`http://meta.test:${port}/`, opts(table({ 'meta.test': ['169.254.169.254'] }))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UrlNotAllowedError);
    expect(hits).toEqual([]);
  });

  it('refuses a redirect to a private host, having sent nothing to it', async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `http://inside.test:${port}/secret`);
      res.end();
    };
    const resolve = table({ 'svc.test': ['127.0.0.1'], 'inside.test': ['10.0.0.7'] });
    const err = await fetchPublic(`http://svc.test:${port}/start`, opts(resolve)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UrlNotAllowedError);
    expect(hits.map((h) => h.url)).toEqual(['/start']);
  });

  it('refuses a redirect to an IP literal of the metadata service', async () => {
    handler = (_req, res) => {
      res.statusCode = 301;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
      res.end();
    };
    const err = await fetchPublic(`http://svc.test:${port}/`, opts(table({ 'svc.test': ['127.0.0.1'] }))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UrlNotAllowedError);
  });

  it('refuses a redirect to a non-http scheme via assertAllowedUrl', async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'file:///etc/passwd');
      res.end();
    };
    const err = (await fetchPublic(`http://svc.test:${port}/`, opts(table({ 'svc.test': ['127.0.0.1'] }))).catch(
      (e: unknown) => e,
    )) as UrlNotAllowedError;
    expect(err).toBeInstanceOf(UrlNotAllowedError);
    expect(err.reason).toBe('scheme');
  });

  it('refuses a redirect whose Location is not a URL', async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://[not-an-ip/');
      res.end();
    };
    const err = (await fetchPublic(`http://svc.test:${port}/`, opts(table({ 'svc.test': ['127.0.0.1'] }))).catch(
      (e: unknown) => e,
    )) as UrlNotAllowedError;
    expect(err).toBeInstanceOf(UrlNotAllowedError);
    expect(err.reason).toBe('invalid');
  });

  it('requires https by default, on the first URL and on every hop', async () => {
    const first = (await fetchPublic(`http://svc.test:${port}/`, {
      resolve: table({ 'svc.test': ['127.0.0.1'] }),
      isAllowedAddress: LOOPBACK_AS_PUBLIC,
    }).catch((e: unknown) => e)) as UrlNotAllowedError;
    expect(first).toBeInstanceOf(UrlNotAllowedError);
    expect(first.reason).toBe('insecure');
    expect(hits).toEqual([]);
  });

  it('holds every hop to allowHosts when given', async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `http://other.test:${port}/`);
      res.end();
    };
    const resolve = table({ 'svc.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'] });
    const err = (await fetchPublic(`http://svc.test:${port}/`, { ...opts(resolve), allowHosts: ['svc.test'] }).catch(
      (e: unknown) => e,
    )) as UrlNotAllowedError;
    expect(err).toBeInstanceOf(UrlNotAllowedError);
    expect(err.reason).toBe('host');
    expect(hits).toHaveLength(1);
  });

  /** /r/<n> redirects to /r/<n+1> until n reaches `stopAt` (Infinity = forever). */
  function redirectChain(stopAt: number): void {
    handler = (req, res) => {
      const n = Number(/\/r\/(\d+)/.exec(req.url ?? '')?.[1] ?? 0);
      if (n >= stopAt) {
        res.end(`end ${n}`);
        return;
      }
      res.statusCode = 302;
      res.setHeader('location', `/r/${n + 1}`);
      res.end();
    };
  }

  it('follows exactly maxRedirects redirects', async () => {
    redirectChain(3);
    const r = await fetchPublic(`http://svc.test:${port}/r/0`, {
      ...opts(table({ 'svc.test': ['127.0.0.1'] })),
      maxRedirects: 3,
    });
    expect(r.hops).toBe(3);
    expect(r.url).toBe(`http://svc.test:${port}/r/3`);
    expect(new TextDecoder().decode(r.body)).toBe('end 3');
    expect(hits).toHaveLength(4);
  });

  it('makes at most maxRedirects follow-up requests, then refuses', async () => {
    redirectChain(Infinity);
    const err = await fetchPublic(`http://svc.test:${port}/r/0`, {
      ...opts(table({ 'svc.test': ['127.0.0.1'] })),
      maxRedirects: 3,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect((err as Error).message).toContain('3');
    expect(hits).toHaveLength(4); // the original request + 3 follow-ups, never a 5th
  });

  it('defaults maxRedirects to 10: 10 are followed, the 11th is refused unsent', async () => {
    redirectChain(10);
    const ok = await fetchPublic(`http://svc.test:${port}/r/0`, opts(table({ 'svc.test': ['127.0.0.1'] })));
    expect(ok.hops).toBe(10);
    hits = [];
    redirectChain(Infinity);
    const err = await fetchPublic(`http://svc.test:${port}/r/0`, opts(table({ 'svc.test': ['127.0.0.1'] }))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect(hits).toHaveLength(11);
  });

  it('maxRedirects: 0 refuses the first redirect', async () => {
    redirectChain(Infinity);
    const err = await fetchPublic(`http://svc.test:${port}/r/0`, {
      ...opts(table({ 'svc.test': ['127.0.0.1'] })),
      maxRedirects: 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect(hits).toHaveLength(1);
  });

  it('rejects a negative or non-integer maxRedirects', async () => {
    await expect(fetchPublic('https://example.com/', { maxRedirects: -1 })).rejects.toThrow(TypeError);
    await expect(fetchPublic('https://example.com/', { maxRedirects: 1.5 })).rejects.toThrow(TypeError);
  });

  it('returns a redirect with no Location as the response', async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.end('no location');
    };
    const r = await fetchPublic(`http://svc.test:${port}/`, opts(table({ 'svc.test': ['127.0.0.1'] })));
    expect(r.status).toBe(302);
    expect(r.hops).toBe(0);
  });

  it('stops before a URL when stopBefore says so, without fetching it', async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'https://tickets.example.com/order?t=secret');
      res.end();
    };
    const r = await fetchPublic(`http://svc.test:${port}/track`, {
      ...opts(table({ 'svc.test': ['127.0.0.1'] })),
      stopBefore: (u) => u.hostname === 'tickets.example.com',
    });
    expect(r).toEqual({ stopped: true, url: 'https://tickets.example.com/order?t=secret', hops: 1 });
    expect(hits).toHaveLength(1);
  });

  it('stopBefore is asked about the first URL too', async () => {
    const r = await fetchPublic('https://tickets.example.com/o', { stopBefore: () => true });
    expect(r).toEqual({ stopped: true, url: 'https://tickets.example.com/o', hops: 0 });
  });

  it('turns a POST into a GET on 303 and drops the body', async () => {
    handler = (req, res) => {
      if (req.url === '/form') {
        res.statusCode = 303;
        res.setHeader('location', '/done');
        res.end();
        return;
      }
      res.end('done');
    };
    const r = await fetchPublic(`http://svc.test:${port}/form`, {
      ...opts(table({ 'svc.test': ['127.0.0.1'] })),
      method: 'POST',
      body: 'a=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(r.status).toBe(200);
    expect(hits.map((h) => h.method)).toEqual(['POST', 'GET']);
    expect(hits[1]?.headers['content-type']).toBeUndefined();
  });

  it('keeps method and body on 307', async () => {
    let seen = '';
    handler = (req, res) => {
      if (req.url === '/a') {
        res.statusCode = 307;
        res.setHeader('location', '/b');
        res.end();
        return;
      }
      req.setEncoding('utf8');
      req.on('data', (c: string) => (seen += c));
      req.on('end', () => res.end('ok'));
    };
    await fetchPublic(`http://svc.test:${port}/a`, {
      ...opts(table({ 'svc.test': ['127.0.0.1'] })),
      method: 'PUT',
      body: 'payload',
    });
    expect(hits.map((h) => h.method)).toEqual(['PUT', 'PUT']);
    expect(seen).toBe('payload');
  });

  it('drops credential headers on a cross-origin hop, keeps them same-origin', async () => {
    handler = (req, res) => {
      if (req.url === '/1') {
        res.statusCode = 302;
        res.setHeader('location', '/2');
      } else if (req.url === '/2') {
        res.statusCode = 302;
        res.setHeader('location', `http://other.test:${port}/3`);
      }
      res.end();
    };
    const resolve = table({ 'svc.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'] });
    await fetchPublic(`http://svc.test:${port}/1`, {
      ...opts(resolve),
      headers: { authorization: 'Bearer t', cookie: 'sid=1', 'x-keep': 'yes' },
    });
    expect(hits.map((h) => [h.url, h.headers.authorization, h.headers.cookie, h.headers['x-keep']])).toEqual([
      ['/1', 'Bearer t', 'sid=1', 'yes'],
      ['/2', 'Bearer t', 'sid=1', 'yes'],
      ['/3', undefined, undefined, 'yes'],
    ]);
  });

  it('caps the body at maxBytes', async () => {
    handler = (_req, res) => {
      res.end('x'.repeat(2048));
    };
    const err = await fetchPublic(`http://svc.test:${port}/`, {
      ...opts(table({ 'svc.test': ['127.0.0.1'] })),
      maxBytes: 1024,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
  });

  it('bounds the whole exchange by timeoutMs', async () => {
    handler = () => {
      /* never answers */
    };
    const err = await fetchPublic(`http://svc.test:${port}/`, {
      ...opts(table({ 'svc.test': ['127.0.0.1'] })),
      timeoutMs: 50,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
  });

  it("propagates the caller's own abort", async () => {
    handler = () => {
      /* never answers */
    };
    const ctl = new AbortController();
    const p = fetchPublic(`http://svc.test:${port}/`, { ...opts(table({ 'svc.test': ['127.0.0.1'] })), signal: ctl.signal });
    setTimeout(() => ctl.abort(new Error('caller gave up')), 20);
    await expect(p).rejects.toThrow('caller gave up');
  });

  it('reports an unreachable host as a transport failure', async () => {
    const err = (await fetchPublic('https://nowhere.test/', { resolve: table({}) }).catch(
      (e: unknown) => e,
    )) as { kind?: string; message: string };
    expect(err.kind).toBe('transport');
    expect(err.message).toContain('nowhere.test');
  });

  it('uses a caller-supplied dispatcher as-is', async () => {
    const dispatcher = createPublicOnlyDispatcher({
      resolve: table({ 'svc.test': ['127.0.0.1'] }),
      isAllowedAddress: LOOPBACK_AS_PUBLIC,
    });
    try {
      const r = await fetchPublic(`http://svc.test:${port}/`, { dispatcher, requireHttps: false });
      expect(r.status).toBe(200);
      const again = await fetchPublic(`http://svc.test:${port}/`, { dispatcher, requireHttps: false });
      expect(again.status).toBe(200); // not closed after the first call
    } finally {
      await dispatcher.destroy();
    }
  });
});

describe('subpath isolation', () => {
  it('keeps netguard (and undici) out of the root barrel', () => {
    const root = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8');
    expect(root).not.toMatch(/netguard|undici/);
  });
});
