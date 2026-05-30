import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFetchproxyTransport,
  createBootstrapOpts,
  // re-exports from @fetchproxy/server
  mapWithConcurrency,
  withDeadline,
  TokenBucket,
  classifyBotWall,
  retryOnceOnTimeout,
  FetchproxyProtocolError,
  FetchproxyHttpError,
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  classifyBridgeError,
} from './index.js';

let identityDir: string;

beforeEach(() => {
  identityDir = mkdtempSync(join(tmpdir(), 'fp-identity-'));
});

afterEach(() => {
  rmSync(identityDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.FP_TEST_DEBUG;
});

describe('re-exports from @fetchproxy/server', () => {
  it('re-exports the bridge primitives as live functions/classes', () => {
    expect(typeof mapWithConcurrency).toBe('function');
    expect(typeof withDeadline).toBe('function');
    expect(typeof TokenBucket).toBe('function'); // class
    expect(typeof classifyBotWall).toBe('function');
    expect(typeof retryOnceOnTimeout).toBe('function');
  });

  it('re-exports the Fetchproxy* error hierarchy', () => {
    // BridgeDown/Timeout subclass the protocol error; HttpError is a sibling
    // (it extends Error directly). `Sub.prototype instanceof Base` is the
    // canonical static subclass check.
    expect(FetchproxyBridgeDownError.prototype instanceof FetchproxyProtocolError).toBe(true);
    expect(FetchproxyTimeoutError.prototype instanceof FetchproxyProtocolError).toBe(true);
    expect(FetchproxyProtocolError.prototype instanceof Error).toBe(true);
    expect(FetchproxyHttpError.prototype instanceof Error).toBe(true);
  });

  it('re-exported TokenBucket acquires immediately when tokens are available', async () => {
    const tb = new TokenBucket({ ratePerMinute: 60, burst: 1 });
    await expect(tb.acquire()).resolves.toBeUndefined();
  });

  it('re-exported mapWithConcurrency maps with a bound', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6]);
  });
});

describe('createFetchproxyTransport', () => {
  it('constructs a FetchproxyServer wrapper exposing the lifecycle surface', () => {
    const t = createFetchproxyTransport({
      serverName: 'redfin-mcp',
      version: '9.9.9',
      domains: ['redfin.com'],
      identityDir,
    });
    expect(typeof t.start).toBe('function');
    expect(typeof t.close).toBe('function');
    expect(typeof t.status).toBe('function');
    // The wrapped inner server is reachable for verb calls.
    expect(t.server).toBeDefined();
    expect(typeof t.server.request).toBe('function');
    expect(t.role).toBeNull(); // null until first verb / connect
  });

  it('forwards optional config (fetchTimeoutMs) only when provided', () => {
    const t = createFetchproxyTransport({
      serverName: 'redfin-mcp',
      version: '1.0.0',
      domains: ['redfin.com'],
      fetchTimeoutMs: 5_000,
      identityDir,
    });
    const health = t.status();
    expect(health.fetchTimeoutMs).toBe(5_000);
  });

  it('start() loads identity and is safe (no network) with a tmp identityDir', async () => {
    const t = createFetchproxyTransport({
      serverName: 'redfin-mcp',
      version: '1.0.0',
      domains: ['redfin.com'],
      identityDir,
    });
    await expect(t.start()).resolves.toBeUndefined();
    await t.close();
  });

  it('logs the bridge role to stderr on start() only when the debug env var is set', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = createFetchproxyTransport({
      serverName: 'redfin-mcp',
      version: '1.0.0',
      domains: ['redfin.com'],
      debugEnvVar: 'FP_TEST_DEBUG',
      identityDir,
    });
    await t.start();
    expect(errSpy).not.toHaveBeenCalled(); // unset → silent
    await t.close();

    process.env.FP_TEST_DEBUG = '1';
    const t2 = createFetchproxyTransport({
      serverName: 'redfin-mcp',
      version: '1.0.0',
      domains: ['redfin.com'],
      debugEnvVar: 'FP_TEST_DEBUG',
      identityDir,
    });
    await t2.start();
    expect(errSpy).toHaveBeenCalled();
    const joined = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(joined).toContain('redfin-mcp');
    await t2.close();
  });

  it('treats a placeholder/`null` debug env value as unset (no logging)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.FP_TEST_DEBUG = '${REDFIN_DEBUG}'; // unexpanded MCP host placeholder
    const t = createFetchproxyTransport({
      serverName: 'redfin-mcp',
      version: '1.0.0',
      domains: ['redfin.com'],
      debugEnvVar: 'FP_TEST_DEBUG',
      identityDir,
    });
    await t.start();
    expect(errSpy).not.toHaveBeenCalled();
    await t.close();

    errSpy.mockClear();
    process.env.FP_TEST_DEBUG = 'null';
    const t2 = createFetchproxyTransport({
      serverName: 'redfin-mcp',
      version: '1.0.0',
      domains: ['redfin.com'],
      debugEnvVar: 'FP_TEST_DEBUG',
      identityDir,
    });
    await t2.start();
    expect(errSpy).not.toHaveBeenCalled();
    await t2.close();
  });

  it('requires at least one domain', () => {
    expect(() =>
      createFetchproxyTransport({
        serverName: 'redfin-mcp',
        version: '1.0.0',
        domains: [],
        identityDir,
      }),
    ).toThrow(/domain/i);
  });

  it('requires a serverName', () => {
    expect(() =>
      createFetchproxyTransport({
        serverName: '',
        version: '1.0.0',
        domains: ['redfin.com'],
        identityDir,
      }),
    ).toThrow(/serverName/i);
  });
});

describe('createBootstrapOpts', () => {
  it('builds a single-domain opts fragment', () => {
    const opts = createBootstrapOpts({ domains: ['opentable.com'] });
    expect(opts.domains).toEqual(['opentable.com']);
    // No capture/storage declarations → default capabilities (left unset → ['fetch']).
    expect(opts.capabilities).toBeUndefined();
  });

  it('accepts a bare string for the single-domain ergonomic', () => {
    const opts = createBootstrapOpts({ domains: 'redfin.com' });
    expect(opts.domains).toEqual(['redfin.com']);
  });

  it('threads a storageDomain capture-header bootstrap into capabilities + decls', () => {
    const opts = createBootstrapOpts({
      domains: ['onehome.com'],
      storageDomain: 'portal.onehome.com',
      bootstrap: {
        captureHeaders: [
          { urlPattern: 'https://portal.onehome.com/api/graphql*', headerName: 'Authorization' },
        ],
      },
    });
    expect(opts.domains).toEqual(['onehome.com']);
    expect(opts.capabilities).toContain('capture_request_header');
    expect(opts.captureHeaders).toEqual([
      { urlPattern: 'https://portal.onehome.com/api/graphql*', headerName: 'Authorization' },
    ]);
  });

  it('derives capabilities from each bootstrap declaration kind', () => {
    const opts = createBootstrapOpts({
      domains: ['honeybook.com', 'hbsplit.com'],
      storageDomain: 'honeybook.com',
      bootstrap: {
        localStorageKeys: ['jStorage'],
        localStoragePointers: [{ key: 'jStorage', jsonPointer: '/auth/token' }],
        cookieKeys: ['session'],
      },
    });
    expect(opts.domains).toEqual(['honeybook.com', 'hbsplit.com']);
    expect(opts.capabilities).toEqual(
      expect.arrayContaining(['read_local_storage', 'read_cookies']),
    );
    expect(opts.localStorageKeys).toEqual(['jStorage']);
    expect(opts.localStoragePointers).toEqual([{ key: 'jStorage', jsonPointer: '/auth/token' }]);
    expect(opts.cookieKeys).toEqual(['session']);
  });

  it('does not duplicate a capability when multiple decls of the same kind exist', () => {
    const opts = createBootstrapOpts({
      domains: ['resy.com'],
      bootstrap: {
        captureHeaders: [
          { urlPattern: 'https://resy.com/a*', headerName: 'Authorization' },
          { urlPattern: 'https://resy.com/b*', headerName: 'X-Resy-Auth-Token' },
        ],
      },
    });
    const caps = opts.capabilities ?? [];
    expect(caps.filter((c) => c === 'capture_request_header')).toHaveLength(1);
  });

  it('rejects an empty domains list', () => {
    expect(() => createBootstrapOpts({ domains: [] })).toThrow(/domain/i);
  });

  it('produces opts that FetchproxyServer accepts (round-trip)', () => {
    const opts = createBootstrapOpts({
      domains: ['onehome.com'],
      storageDomain: 'portal.onehome.com',
      bootstrap: {
        captureHeaders: [
          { urlPattern: 'https://portal.onehome.com/graphql*', headerName: 'Authorization' },
        ],
      },
    });
    const t = createFetchproxyTransport({
      ...opts,
      serverName: 'onehome-mcp',
      version: '1.0.0',
      identityDir,
    });
    expect(t.server).toBeDefined();
  });
});

describe('classifyBridgeError', () => {
  it('classifies a FetchproxyTimeoutError as timeout with a hint', () => {
    const err = new FetchproxyTimeoutError({
      url: 'https://x',
      timeoutMs: 1000,
      elapsedMs: 1001,
      role: 'host',
      port: 1,
    });
    const out = classifyBridgeError(err);
    expect(out.type).toBe('timeout');
    expect(out.message).toBeTruthy();
    expect(out.hint).toBeTruthy();
  });

  it('classifies a FetchproxyBridgeDownError as bridge_down and surfaces its hint', () => {
    const err = new FetchproxyBridgeDownError({ originalError: 'sw gone' });
    const out = classifyBridgeError(err);
    expect(out.type).toBe('bridge_down');
    expect(out.hint).toBeTruthy();
  });

  it('classifies a FetchproxyHttpError as http', () => {
    const err = new FetchproxyHttpError(
      { status: 503, statusText: 'x', url: 'https://x', body: '', headers: {} } as never,
      'upstream 503',
    );
    const out = classifyBridgeError(err);
    expect(out.type).toBe('http');
    expect(out.message).toMatch(/503|upstream/);
  });

  it('classifies a base FetchproxyProtocolError as protocol', () => {
    const out = classifyBridgeError(new FetchproxyProtocolError('no_tab'));
    expect(out.type).toBe('protocol');
    expect(out.message).toMatch(/no_tab/);
  });

  it('classifies anything else as unknown', () => {
    const out = classifyBridgeError(new Error('random'));
    expect(out.type).toBe('unknown');
    expect(out.message).toMatch(/random/);
  });

  it('handles non-Error throwables as unknown', () => {
    const out = classifyBridgeError('a string');
    expect(out.type).toBe('unknown');
    expect(out.message).toMatch(/a string/);
  });

  it('redacts/truncates the surfaced message (security)', () => {
    const out = classifyBridgeError(new Error('Bearer eyJleaktoken99999.p.s here'));
    expect(out.message).not.toMatch(/eyJleaktoken99999/);
  });
});
