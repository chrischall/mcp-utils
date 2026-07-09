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
  classifyRowError,
  chunk,
  sleep,
  extractGlobalAssign,
  extractBalancedObject,
  extractImgTags,
  lastPathSegment,
  bridgeErrorInfo,
  registerBridgeHealthcheckTool,
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
