import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFetchproxyTransport,
  createBootstrapOpts,
  // re-exports from @fetchproxy/server
  FetchproxyServer,
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
  classifyRowError,
  chunk,
  sleep,
  extractGlobalAssign,
  extractBalancedObject,
  extractImgTags,
  lastPathSegment,
  bridgeErrorInfo,
  registerBridgeHealthcheckTool,
  FetchproxySessionNotReadyError,
  type FetchproxyTransport,
} from './index.js';
import type { BridgeProbeResult } from '@fetchproxy/server';
import { createTestHarness, parseToolResult } from '../test/index.js';

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

  it('re-exports the FULL @fetchproxy/server surface incl. page-state/scrape + async helpers', () => {
    // So a consumer can route its ENTIRE @fetchproxy/server import through this
    // subpath (single import site) without splitting onto two sources.
    for (const fn of [chunk, sleep, extractGlobalAssign, extractBalancedObject, extractImgTags, lastPathSegment]) {
      expect(typeof fn).toBe('function');
    }
    expect(lastPathSegment('https://x.test/a/b/c')).toBe('c');
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
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

  // --- Enhancement 1: opt-in startup banner --------------------------------
  it('does NOT emit a startup banner by default (logListening unset)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = createFetchproxyTransport({
      serverName: 'compass-mcp',
      version: '1.2.3',
      domains: ['compass.com'],
      identityDir,
    });
    await t.start();
    expect(errSpy).not.toHaveBeenCalled();
    await t.close();
  });

  it('emits the canonical startup banner to stderr when logListening is true', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = createFetchproxyTransport({
      serverName: 'compass-mcp',
      version: '1.2.3',
      domains: ['compass.com'],
      port: 40555,
      logListening: true,
      identityDir,
    });
    await t.start();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = errSpy.mock.calls[0].join(' ');
    // Canonical compass format: includes 127.0.0.1:<port>, role, version.
    expect(line).toBe(
      '[compass-mcp:bridge] listening on 127.0.0.1:40555 (role=unknown, version=1.2.3)',
    );
    await t.close();
  });

  it('emits only the canonical banner (not the redundant debug line) when logListening + debugEnvVar are both on', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = createFetchproxyTransport({
      serverName: 'compass-mcp',
      version: '1.2.3',
      domains: ['compass.com'],
      port: 40556,
      logListening: true,
      debugEnvVar: 'FP_TEST_DEBUG',
      env: { FP_TEST_DEBUG: '1' },
      identityDir,
    });
    await t.start();
    // The debug line is a strict subset of the canonical one, so only the
    // canonical (port-bearing) banner is emitted — not both.
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0].join(' ')).toContain('listening on 127.0.0.1:40556');
    await t.close();
  });

  // --- Enhancement 2: serverVersion in status() ----------------------------
  it('status() carries serverVersion sourced from the version opt', async () => {
    const t = createFetchproxyTransport({
      serverName: 'homes-mcp',
      version: '7.7.7',
      domains: ['homes.com'],
      identityDir,
    });
    const health = t.status();
    expect(health.serverVersion).toBe('7.7.7');
    await t.close();
  });

  // --- Enhancement 3: mock-injectable server (test seam) -------------------
  it('uses an injected createServer factory instead of constructing a real server', () => {
    const ctorOptsMock = vi.fn();
    const downloadMock = vi.fn();
    const fakeServer = {
      role: null,
      download: downloadMock,
      request: vi.fn(),
      listen: vi.fn(),
      close: vi.fn(),
      bridgeHealth: vi.fn(),
    };
    const t = createFetchproxyTransport({
      serverName: 'musescore-mcp',
      version: '0.0.0-test',
      domains: ['musescore.com'],
      identityDir,
      // Inject a mock server: no real FetchproxyServer / WebSocket is built.
      createServer: (opts) => {
        ctorOptsMock(opts);
        return fakeServer as never;
      },
    });
    expect(ctorOptsMock).toHaveBeenCalledOnce();
    // The injected instance is the one exposed on `.server` (verb passthrough).
    expect(t.server).toBe(fakeServer);
    // The forwarded opts exclude the factory-only knobs (createServer, etc.).
    const forwarded = ctorOptsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded.serverName).toBe('musescore-mcp');
    expect(forwarded).not.toHaveProperty('createServer');
    expect(forwarded).not.toHaveProperty('logListening');
  });

  // --- @fetchproxy/server 1.7.0: graphql capability -------------------------
  it("forwards 'graphql' capability + graphqlOps to the constructor verbatim, and exposes graphqlQuery on .server", () => {
    // createFetchproxyTransport does no per-field mapping — the full
    // FetchproxyServerOpts (including this 1.7.0+ addition) is forwarded as
    // `...serverOpts`. This pins that the graphql capability rides through
    // exactly like every other opt, with no code change needed here beyond
    // the @fetchproxy/server version bump.
    const ctorOptsMock = vi.fn();
    const t = createFetchproxyTransport({
      serverName: 'opentable-mcp',
      version: '0.0.0-test',
      domains: ['opentable.com'],
      identityDir,
      capabilities: ['fetch', 'graphql'],
      graphqlOps: [{ name: 'availability', operationName: 'RestaurantsAvailability' }],
      createServer: (opts) => {
        ctorOptsMock(opts);
        return new FetchproxyServer(opts);
      },
    });
    const forwarded = ctorOptsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded.capabilities).toEqual(['fetch', 'graphql']);
    expect(forwarded.graphqlOps).toEqual([
      { name: 'availability', operationName: 'RestaurantsAvailability' },
    ]);
    // The real FetchproxyServer instance built from those opts exposes the
    // new verb — confirms the bumped @fetchproxy/server's type surface
    // (not just its runtime shape) is visible through this package's
    // re-exported FetchproxyServer class.
    expect(typeof t.server.graphqlQuery).toBe('function');
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
          { host: 'portal.onehome.com', path: '/api/graphql*', headerName: 'Authorization' },
        ],
      },
    });
    expect(opts.domains).toEqual(['onehome.com']);
    expect(opts.capabilities).toContain('capture_request_header');
    expect(opts.captureHeaders).toEqual([
      { host: 'portal.onehome.com', path: '/api/graphql*', headerName: 'Authorization' },
    ]);
  });

  /**
   * Declaring a bootstrap must not COST you the fetch verb.
   *
   * `capabilities` replaces the server's default rather than extending it, so
   * a fragment built from declarations alone shipped
   * `capabilities: ['capture_request_header']` — and the transport that spread
   * it lost `fetch` silently, surfacing only at runtime as
   * `capability "fetch" not granted (declared: [capture_request_header])`.
   * Found in resy-mcp, whose capture path worked and whose fallback request
   * could not run. alltrails-mcp had already sidestepped it by listing
   * capabilities by hand — i.e. by not using the helper written to stop
   * exactly this class of mistake.
   *
   * Every fetchproxy transport has the fetch verbs on it, so `fetch` is not a
   * capability a bootstrap declaration can imply the absence of.
   */
  it('keeps fetch alongside every derived capability', () => {
    const opts = createBootstrapOpts({
      domains: 'resy.com',
      bootstrap: {
        captureHeaders: [{ host: 'api.resy.com', path: '/*', headerName: 'x-resy-auth-token' }],
      },
    });
    expect(opts.capabilities).toContain('fetch');
    expect(opts.capabilities).toContain('capture_request_header');
  });

  it('lists fetch first, so the declared set reads default-then-additions', () => {
    const opts = createBootstrapOpts({
      domains: 'x.com',
      bootstrap: { cookieKeys: ['session'] },
    });
    expect(opts.capabilities?.[0]).toBe('fetch');
  });

  it('does not duplicate fetch when a declaration set is empty', () => {
    const opts = createBootstrapOpts({ domains: 'x.com', bootstrap: { cookieKeys: [] } });
    // Nothing declared → still no capabilities key, so the server keeps its
    // own default rather than being handed a one-element restatement of it.
    expect(opts.capabilities).toBeUndefined();
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

  it('derives read_dom + passes domSelectors through', () => {
    const opts = createBootstrapOpts({
      domains: ['easytable.com'],
      bootstrap: {
        domSelectors: [
          { name: 'turnstileToken', selector: 'input[name="cf-turnstile-response"]' },
        ],
      },
    });
    expect(opts.capabilities).toEqual(expect.arrayContaining(['read_dom']));
    expect(opts.domSelectors).toEqual([
      { name: 'turnstileToken', selector: 'input[name="cf-turnstile-response"]' },
    ]);
  });

  it('omits domSelectors + read_dom when none are declared', () => {
    const opts = createBootstrapOpts({ domains: ['easytable.com'] });
    expect(opts.domSelectors).toBeUndefined();
    expect(opts.capabilities ?? []).not.toContain('read_dom');
  });

  it('does not duplicate a capability when multiple decls of the same kind exist', () => {
    const opts = createBootstrapOpts({
      domains: ['resy.com'],
      bootstrap: {
        captureHeaders: [
          { host: 'resy.com', path: '/a*', headerName: 'Authorization' },
          { host: 'resy.com', path: '/b*', headerName: 'X-Resy-Auth-Token' },
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
          { host: 'portal.onehome.com', path: '/graphql*', headerName: 'Authorization' },
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

describe('raw re-exports (drop-in for @fetchproxy/server)', () => {
  it('re-exports the RAW classifyBridgeError that returns a bare kind string', () => {
    // Consumers compare the result against string kinds (e.g. === 'bridge_down').
    expect(typeof classifyBridgeError(new FetchproxyBridgeDownError({ originalError: 'x' }))).toBe('string');
    expect(classifyBridgeError(new FetchproxyTimeoutError({ url: 'https://x', timeoutMs: 1, elapsedMs: 2, role: 'host', port: 1 }))).toBe('timeout');
  });

  it('re-exports classifyRowError as a function', () => {
    expect(typeof classifyRowError).toBe('function');
  });
});

describe('bridgeErrorInfo (envelope)', () => {
  it('classifies a FetchproxyTimeoutError as timeout with a hint', () => {
    const err = new FetchproxyTimeoutError({
      url: 'https://x',
      timeoutMs: 1000,
      elapsedMs: 1001,
      role: 'host',
      port: 1,
    });
    const out = bridgeErrorInfo(err);
    expect(out.type).toBe('timeout');
    expect(out.message).toBeTruthy();
    expect(out.hint).toBeTruthy();
  });

  it('classifies a FetchproxyBridgeDownError as bridge_down and surfaces its hint', () => {
    const err = new FetchproxyBridgeDownError({ originalError: 'sw gone' });
    const out = bridgeErrorInfo(err);
    expect(out.type).toBe('bridge_down');
    expect(out.hint).toBeTruthy();
  });

  it('classifies a FetchproxyHttpError as http', () => {
    const err = new FetchproxyHttpError(
      { status: 503, statusText: 'x', url: 'https://x', body: '', headers: {} } as never,
      'upstream 503',
    );
    const out = bridgeErrorInfo(err);
    expect(out.type).toBe('http');
    expect(out.message).toMatch(/503|upstream/);
  });

  it('classifies a base FetchproxyProtocolError as protocol', () => {
    const out = bridgeErrorInfo(new FetchproxyProtocolError('no_tab'));
    expect(out.type).toBe('protocol');
    expect(out.message).toMatch(/no_tab/);
  });

  it('classifies anything else as unknown', () => {
    const out = bridgeErrorInfo(new Error('random'));
    expect(out.type).toBe('unknown');
    expect(out.message).toMatch(/random/);
  });

  it('handles non-Error throwables as unknown', () => {
    const out = bridgeErrorInfo('a string');
    expect(out.type).toBe('unknown');
    expect(out.message).toMatch(/a string/);
  });

  it('redacts/truncates the surfaced message (security)', () => {
    const out = bridgeErrorInfo(new Error('Bearer eyJleaktoken99999.p.s here'));
    expect(out.message).not.toMatch(/eyJleaktoken99999/);
  });
});

describe('createFetchproxyTransport — verb adapters', () => {
  it('fetch() threads the default subdomain and returns the {status,body,url} triple', async () => {
    const t = createFetchproxyTransport({
      serverName: 'redfin-mcp',
      version: '1.0.0',
      domains: ['redfin.com'],
      defaultSubdomain: 'www',
      identityDir,
    });
    const reqSpy = vi
      .spyOn(t.server, 'request')
      .mockResolvedValue({ status: 200, body: 'ok', url: 'https://www.redfin.com/robots.txt' });

    const res = await t.fetch({ method: 'GET', path: '/robots.txt' });

    expect(res).toEqual({ status: 200, body: 'ok', url: 'https://www.redfin.com/robots.txt' });
    expect(reqSpy).toHaveBeenCalledWith('GET', '/robots.txt', { subdomain: 'www' });
  });

  it('fetch() omits subdomain entirely for an apex-served MCP (no defaultSubdomain)', async () => {
    const t = createFetchproxyTransport({
      serverName: 'musescore-mcp',
      version: '1.0.0',
      domains: ['musescore.com'],
      identityDir,
    });
    const reqSpy = vi
      .spyOn(t.server, 'request')
      .mockResolvedValue({ status: 200, body: 'x', url: 'https://musescore.com/robots.txt' });

    await t.fetch({ method: 'GET', path: '/robots.txt', headers: { 'X-A': '1' } });

    // No `subdomain` key at all — the apex host is targeted.
    expect(reqSpy).toHaveBeenCalledWith('GET', '/robots.txt', { headers: { 'X-A': '1' } });
  });

  it('fetch() lets a per-call subdomain override the default', async () => {
    const t = createFetchproxyTransport({
      serverName: 'homes-mcp',
      version: '1.0.0',
      domains: ['homes.com'],
      defaultSubdomain: 'www',
      identityDir,
    });
    const reqSpy = vi
      .spyOn(t.server, 'request')
      .mockResolvedValue({ status: 200, body: '', url: 'https://photos.homes.com/x' });

    await t.fetch({ method: 'POST', path: '/x', body: 'b', subdomain: 'photos' });

    expect(reqSpy).toHaveBeenCalledWith('POST', '/x', {
      body: 'b',
      subdomain: 'photos',
    });
  });

  it('requestJson() returns both data and the raw result, threading the default subdomain', async () => {
    const t = createFetchproxyTransport({
      serverName: 'compass-mcp',
      version: '1.0.0',
      domains: ['compass.com'],
      defaultSubdomain: 'www',
      identityDir,
    });
    const jsonSpy = vi.spyOn(t.server, 'requestJson').mockResolvedValue({
      data: { hello: 'world' },
      result: { status: 200, body: '{"hello":"world"}', url: 'https://www.compass.com/api' },
    });

    const out = await t.requestJson<{ hello: string }>('POST', '/api', { body: { q: 1 } });

    expect(out.data).toEqual({ hello: 'world' });
    expect(out.result).toEqual({
      status: 200,
      body: '{"hello":"world"}',
      url: 'https://www.compass.com/api',
    });
    expect(jsonSpy).toHaveBeenCalledWith('POST', '/api', { body: { q: 1 }, subdomain: 'www' });
  });

  it('runProbe() delegates straight to the server', async () => {
    const t = createFetchproxyTransport({
      serverName: 'redfin-mcp',
      version: '1.0.0',
      domains: ['redfin.com'],
      identityDir,
    });
    const probeResult: BridgeProbeResult = {
      ok: true,
      elapsed_ms: 5,
      bridge: {
        role: 'host',
        port: 40000,
        server_version: '1.0.0',
        fetch_timeout_ms: 30000,
        last_success_at: 1,
        last_failure_at: null,
        last_failure_reason: null,
        consecutive_failures: 0,
      },
    };
    const probeSpy = vi.spyOn(t.server, 'runProbe').mockResolvedValue(probeResult);
    const fn = async (p: string) => p;

    const out = await t.runProbe(fn, '/robots.txt');

    expect(out).toBe(probeResult);
    expect(probeSpy).toHaveBeenCalledWith(fn, '/robots.txt');
  });
});

describe('registerBridgeHealthcheckTool', () => {
  // A minimal fake transport: `runProbe` returns a caller-supplied probe
  // result (optionally invoking `fetchFn` so the body-length path is exercised),
  // and `status()` supplies the liveness counter the projection omits.
  function fakeTransport(
    probeResult: BridgeProbeResult,
    opts: { lastExtensionMessageAt?: number | null; invokeFetchFn?: boolean } = {},
  ): Pick<FetchproxyTransport, 'runProbe' | 'status'> {
    return {
      async runProbe(fetchFn, probePath) {
        if (opts.invokeFetchFn !== false && probeResult.ok) {
          await fetchFn(probePath);
        } else if (!probeResult.ok) {
          // Mirror runProbe: call fetchFn so the consumer's catch captures the throw.
          try {
            await fetchFn(probePath);
          } catch {
            /* swallow — runProbe already classified it into probeResult.error */
          }
        }
        return probeResult;
      },
      status() {
        return {
          role: probeResult.bridge.role,
          port: probeResult.bridge.port,
          serverVersion: probeResult.bridge.server_version,
          fetchTimeoutMs: probeResult.bridge.fetch_timeout_ms,
          bridgeReviveDelayMs: 2000,
          lastSuccessAt: probeResult.bridge.last_success_at,
          lastFailureAt: probeResult.bridge.last_failure_at,
          lastFailureReason: probeResult.bridge.last_failure_reason,
          consecutiveFailures: probeResult.bridge.consecutive_failures,
          lastExtensionMessageAt: opts.lastExtensionMessageAt ?? null,
          keepAlive: {
            enabled: true,
            intervalMs: 20000,
            maxIdleMs: 300000,
            lastPingAt: null,
            totalPings: 0,
            idleSinceMs: null,
          },
          swEviction: {
            lazyReviveAttempts: 0,
            lazyReviveSuccesses: 0,
            lastEvictionDetectedAt: null,
          },
        };
      },
    };
  }

  const healthyProbe = (port: number): BridgeProbeResult => ({
    ok: true,
    elapsed_ms: 12,
    bridge: {
      role: 'host',
      port,
      server_version: '1.0.0',
      fetch_timeout_ms: 30000,
      last_success_at: Date.now(),
      last_failure_at: null,
      last_failure_reason: null,
      consecutive_failures: 0,
    },
  });

  it('registers a <prefix>_healthcheck tool', async () => {
    const transport = fakeTransport(healthyProbe(37149));
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'compass',
        probePath: '/robots.txt',
        hostLabel: 'compass.com',
        transport,
        probeFn: async () => 'body',
      }),
    );
    const tools = await harness.listTools();
    expect(tools.map((t) => t.name)).toContain('compass_healthcheck');
    await harness.close();
  });

  it('healthy probe → ok result with role + timing + body length', async () => {
    const transport = fakeTransport(healthyProbe(37149), { lastExtensionMessageAt: 999 });
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'compass',
        probePath: '/robots.txt',
        hostLabel: 'compass.com',
        transport,
        probeFn: async () => 'robots body',
      }),
    );
    const res = parseToolResult<{
      ok: boolean;
      bridge: { role: string; port: number; last_extension_message_at: number | null };
      probe: { url: string; elapsed_ms: number; status?: number; body_length?: number };
      hint: string;
    }>(await harness.callTool('compass_healthcheck'));

    expect(res.ok).toBe(true);
    expect(res.bridge.role).toBe('host');
    expect(res.bridge.last_extension_message_at).toBe(999);
    expect(res.probe.url).toBe('https://compass.com/robots.txt');
    expect(res.probe.status).toBe(200);
    expect(res.probe.body_length).toBe('robots body'.length);
    expect(res.probe.elapsed_ms).toBe(12);
    expect(res.hint).toMatch(/round-tripped/i);
    await harness.close();
  });

  it('bridge-down → failure with the actionable hint AND the real configured port (not 37149)', async () => {
    const REAL_PORT = 40555; // deliberately NOT the default 37149
    const downProbe: BridgeProbeResult = {
      ok: false,
      elapsed_ms: 3,
      bridge: {
        role: null, // bridge_down can fire before a role is bound
        port: REAL_PORT,
        server_version: '1.0.0',
        fetch_timeout_ms: 30000,
        last_success_at: null,
        last_failure_at: Date.now(),
        last_failure_reason: 'bridge_down: sw gone',
        consecutive_failures: 1,
      },
      error: { kind: 'bridge_down', message: 'sw gone' },
    };
    const transport = fakeTransport(downProbe);
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'musescore',
        probePath: '/robots.txt',
        hostLabel: 'musescore.com',
        transport,
        probeFn: async () => {
          throw new FetchproxyBridgeDownError({ originalError: 'sw gone' });
        },
      }),
    );
    const res = parseToolResult<{
      ok: boolean;
      error?: { kind: string; message: string; bridge_hint?: string };
      hint: string;
    }>(await harness.callTool('musescore_healthcheck'));

    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('bridge_down');
    // The bridge_down hint must win over the role===null fallback.
    expect(res.hint).toMatch(/service worker is not responding/i);
    // The server-authored hint is surfaced.
    expect(res.error?.bridge_hint).toBeTruthy();
    await harness.close();
  });

  it('role===null timeout → hint cites the REAL port, never the hardcoded 37149 (audit bug fix)', async () => {
    const REAL_PORT = 40555;
    const timeoutProbe: BridgeProbeResult = {
      ok: false,
      elapsed_ms: 30001,
      bridge: {
        role: null,
        port: REAL_PORT,
        server_version: '1.0.0',
        fetch_timeout_ms: 30000,
        last_success_at: null,
        last_failure_at: Date.now(),
        last_failure_reason: 'timeout',
        consecutive_failures: 1,
      },
      error: { kind: 'other', message: 'boom' },
    };
    const transport = fakeTransport(timeoutProbe);
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'redfin',
        probePath: '/robots.txt',
        hostLabel: 'www.redfin.com',
        transport,
        probeFn: async () => {
          throw new Error('boom');
        },
      }),
    );
    const res = parseToolResult<{ hint: string }>(
      await harness.callTool('redfin_healthcheck'),
    );

    // The "never bound a role" hint must reference the configured port.
    expect(res.hint).toContain(String(REAL_PORT));
    expect(res.hint).not.toContain('37149');
    await harness.close();
  });
});

describe('bridgeErrorInfo — session_not_ready', () => {
  it('splits the server-authored hint back out of the message and keys the kind', () => {
    const err = new FetchproxySessionNotReadyError({ mcpId: 'hemnet-mcp:0.4.0:abc', pairCode: null });
    const info = bridgeErrorInfo(err);
    expect(info.type).toBe('session_not_ready');
    expect(info.hint).toBe(err.hint);
    // The message no longer carries the hint, so `${message} ${hint}` reads once.
    expect(info.message).toBe('fetchproxy: no confirmed browser session for "hemnet-mcp:0.4.0:abc".');
  });
});

describe('registerBridgeHealthcheckTool — session state (fetchproxy 2.5+)', () => {
  function sessionProbe(
    state: 'no_session' | 'pair_pending' | 'extension_disconnected' | 'linked',
    pairCode: string | null,
  ): BridgeProbeResult {
    return {
      ok: false,
      elapsed_ms: 30_012,
      bridge: {
        role: 'host',
        port: 37150,
        server_version: '2.5.0',
        fetch_timeout_ms: 30000,
        last_success_at: null,
        last_failure_at: null,
        last_failure_reason: null,
        consecutive_failures: 1,
        // 2.5.0 projection fields — typed loosely here so this file also
        // compiles against a 2.4 `BridgeProbeResult`.
        ...({
          session_state: state,
          pending_pair_code: pairCode,
          extension_connected: state !== 'extension_disconnected',
          last_extension_message_at: null,
        } as Record<string, unknown>),
      },
      error: { kind: 'other', message: 'fetchproxy: no confirmed browser session for "x". …' },
    };
  }

  /** The probe throws the real session-not-ready error, as the bridge would. */
  function notReady(pairCode: string | null) {
    return async () => {
      throw new FetchproxySessionNotReadyError({ mcpId: 'hemnet-mcp:0.4.0:abc', pairCode });
    };
  }

  function fakeTransport(probeResult: BridgeProbeResult): Pick<FetchproxyTransport, 'runProbe' | 'status'> {
    return {
      async runProbe(fetchFn, probePath) {
        try {
          await fetchFn(probePath);
        } catch {
          /* classified into probeResult.error by the real server */
        }
        return probeResult;
      },
      status() {
        return { lastExtensionMessageAt: null } as never;
      },
    };
  }

  async function run(probeResult: BridgeProbeResult, probeFn: () => Promise<string>) {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'hemnet',
        probePath: '/graphql',
        hostLabel: 'www.hemnet.se',
        transport: fakeTransport(probeResult),
        probeFn,
      }),
    );
    const res = await harness.callTool('hemnet_healthcheck', {});
    await harness.close();
    return parseToolResult<{
      ok: boolean;
      bridge: Record<string, unknown>;
      error?: { kind: string; bridge_hint?: string };
      hint: string;
    }>(res);
  }

  it('passes the session fields through on the bridge block', async () => {
    const body = await run(sessionProbe('no_session', null), notReady(null));
    expect(body.bridge).toMatchObject({
      session_state: 'no_session',
      pending_pair_code: null,
      extension_connected: true,
      last_extension_message_at: null,
    });
  });

  it('classifies the thrown session-not-ready error itself, even when an older server said "other"', async () => {
    const body = await run(sessionProbe('no_session', null), notReady(null));
    expect(body.ok).toBe(false);
    expect(body.error?.kind).toBe('session_not_ready');
    expect(body.error?.bridge_hint).toMatch(/hasn't confirmed a session/);
  });

  it('pair_pending → the hint names the pair code and the popup', async () => {
    const body = await run(sessionProbe('pair_pending', '457-035'), notReady('457-035'));
    expect(body.hint).toMatch(/approve pair code 457-035 for hemnet-mcp/);
    expect(body.hint).toMatch(/popup/);
  });

  it('extension_disconnected → the hint says no extension is attached, with the real port', async () => {
    const body = await run(sessionProbe('extension_disconnected', null), notReady(null));
    expect(body.hint).toMatch(/No Transporter extension is attached/);
    expect(body.hint).toMatch(/37150/);
  });

  it('no_session → the hint says the hello got no answer and mentions the hosted relay case', async () => {
    const body = await run(sessionProbe('no_session', null), notReady(null));
    expect(body.hint).toMatch(/never confirmed a session for hemnet-mcp/);
    expect(body.hint).toMatch(/hosted bridge/);
  });

  it('a `hints.session_not_ready` override replaces the copy', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'hemnet',
        probePath: '/graphql',
        hostLabel: 'www.hemnet.se',
        transport: fakeTransport(sessionProbe('no_session', null)),
        probeFn: notReady(null),
        hints: { session_not_ready: 'custom copy' },
      }),
    );
    const body = parseToolResult<{ hint: string }>(await harness.callTool('hemnet_healthcheck', {}));
    await harness.close();
    expect(body.hint).toBe('custom copy');
  });
});

describe('registerBridgeHealthcheckTool — `path` for direct-first consumers', () => {
  // hemnet / booli try a direct fetch and switch to the bridge only when
  // Cloudflare walls it, so at registration time there may be no bridge at
  // all, and the probe itself is what flips the fallback. `path()` reports
  // which leg serves calls NOW (read after the probe); `transport` may be a
  // getter returning the bridge once it exists.
  function fakeBridge(state: 'linked' | 'no_session'): Pick<FetchproxyTransport, 'runProbe' | 'status'> {
    return {
      async runProbe() {
        throw new Error('runProbe must not be used on the path-aware route');
      },
      status() {
        return {
          role: 'host',
          port: 37150,
          serverVersion: '2.5.0',
          fetchTimeoutMs: 30000,
          lastSuccessAt: 1,
          lastFailureAt: null,
          lastFailureReason: null,
          consecutiveFailures: 0,
          lastExtensionMessageAt: 42,
          session: { state, pairCode: null, extensionConnected: true },
        } as never;
      },
    };
  }

  type Body = {
    ok: boolean;
    transport?: Record<string, unknown>;
    bridge?: Record<string, unknown>;
    probe: { url: string; elapsed_ms: number; status?: number; body_length?: number };
    error?: { kind: string; message: string };
    hint: string;
  };

  it('direct path, ok: reports the path, no bridge block, and a direct-fetch hint', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'hemnet',
        probePath: '/graphql',
        hostLabel: 'www.hemnet.se',
        transport: () => undefined,
        path: () => ({ transport: 'direct', mode: 'auto' }),
        probeFn: async () => '{"data":{}}',
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('hemnet_healthcheck', {}));
    await harness.close();
    expect(body.ok).toBe(true);
    expect(body.transport).toEqual({ transport: 'direct', mode: 'auto' });
    expect(body.bridge).toBeUndefined();
    expect(body.probe).toMatchObject({ url: 'https://www.hemnet.se/graphql', status: 200, body_length: 11 });
    expect(body.hint).toMatch(/direct fetch/i);
  });

  it('direct path, failing: classifies via classifyThrown and keeps its hint', async () => {
    class WallError extends Error {}
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'hemnet',
        probePath: '/graphql',
        hostLabel: 'www.hemnet.se',
        transport: () => undefined,
        path: () => ({ transport: 'direct', mode: 'direct' }),
        probeFn: async () => {
          throw new WallError('HTTP 403 — Cloudflare bot challenge');
        },
        classifyThrown: (e) =>
          e instanceof WallError ? { kind: 'cloudflare_challenge', hint: 'set HEMNET_TRANSPORT=fetchproxy' } : undefined,
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('hemnet_healthcheck', {}));
    await harness.close();
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ kind: 'cloudflare_challenge', message: 'HTTP 403 — Cloudflare bot challenge' });
    expect(body.hint).toBe('set HEMNET_TRANSPORT=fetchproxy');
    expect(body.bridge).toBeUndefined();
  });

  it('direct path, failing without a classifier: an unknown kind and a direct-path hint', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'hemnet',
        probePath: '/graphql',
        hostLabel: 'www.hemnet.se',
        transport: () => undefined,
        path: () => ({ transport: 'direct', mode: 'direct' }),
        probeFn: async () => {
          throw new Error('fetch failed');
        },
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('hemnet_healthcheck', {}));
    await harness.close();
    expect(body.error).toMatchObject({ kind: 'unknown', message: 'fetch failed' });
    expect(body.hint).toMatch(/direct fetch/i);
    expect(body.hint).toMatch(/no browser bridge/i);
  });

  it('fetchproxy path (after the fallback flipped mid-probe): projects the bridge from status()', async () => {
    let walled = false;
    const bridge = fakeBridge('linked');
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'hemnet',
        probePath: '/graphql',
        hostLabel: 'www.hemnet.se',
        transport: () => (walled ? bridge : undefined),
        path: () => ({ transport: walled ? 'fetchproxy' : 'direct', mode: 'auto' }),
        probeFn: async () => {
          walled = true; // the probe is what flips the fallback
          return 'ok';
        },
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('hemnet_healthcheck', {}));
    await harness.close();
    expect(body.ok).toBe(true);
    expect(body.transport).toEqual({ transport: 'fetchproxy', mode: 'auto' });
    expect(body.bridge).toEqual({
      role: 'host',
      port: 37150,
      server_version: '2.5.0',
      fetch_timeout_ms: 30000,
      last_success_at: 1,
      last_failure_at: null,
      last_failure_reason: null,
      consecutive_failures: 0,
      last_extension_message_at: 42,
      session_state: 'linked',
      pending_pair_code: null,
      extension_connected: true,
    });
  });

  it('fetchproxy path, session never confirmed: the session hint ladder applies', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'hemnet',
        probePath: '/graphql',
        hostLabel: 'www.hemnet.se',
        transport: () => fakeBridge('no_session'),
        path: () => ({ transport: 'fetchproxy', mode: 'auto' }),
        probeFn: async () => {
          throw new FetchproxySessionNotReadyError({ mcpId: 'hemnet-mcp:0.4.0:abc', pairCode: null });
        },
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('hemnet_healthcheck', {}));
    await harness.close();
    expect(body.error?.kind).toBe('session_not_ready');
    expect(body.bridge?.session_state).toBe('no_session');
    expect(body.hint).toMatch(/never confirmed a session for hemnet-mcp/);
  });

  it('refuses a transport getter that returns nothing when no path is supplied', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'x',
        probePath: '/',
        hostLabel: 'x.test',
        transport: () => undefined,
        probeFn: async () => '',
      }),
    );
    const res = await harness.callTool('x_healthcheck', {});
    await harness.close();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/transport\(\) returned nothing/);
  });
});
