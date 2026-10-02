import { describe, expect, it, vi } from 'vitest';

import {
  FetchproxyBridgeDownError,
  FetchproxyHttpError,
  FetchproxySessionNotReadyError,
  createDirectFirstTransport,
  readTransportMode,
  registerBridgeHealthcheckTool,
  type BridgeHealthcheckTransport,
  type FetchproxyTransport,
} from './index.js';
import { EdgeBlockedError } from '../http/index.js';
import { withCallSignal } from '../cancel/index.js';
import { createTestHarness, parseToolResult } from '../test/index.js';

/**
 * The direct-first transport hoisted out of hemnet-mcp and booli-mcp
 * (chrischall/fleet-audit#1020, #988): their `transport-fallback.ts` files
 * differed only in names and log text. These cases port both repos'
 * fallback suites onto the shared router.
 */

const CLOUDFLARE_CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><script>window._cf_chl_opt={cvId:'3'}</script></body></html>`;

/** One leg of the fake: a `graphql`-shaped call, as hemnet / booli expose. */
interface Leg {
  name: string;
  graphql: (q: string) => Promise<string>;
  bridgeTransport?: () => BridgeHealthcheckTransport | undefined;
}

function healthSlice(port = 37150): BridgeHealthcheckTransport {
  return {
    async runProbe() {
      throw new Error('runProbe must not be used on the path-aware route');
    },
    status() {
      return {
        role: 'host',
        port,
        serverVersion: '3.3.0',
        fetchTimeoutMs: 30000,
        lastSuccessAt: 1,
        lastFailureAt: null,
        lastFailureReason: null,
        consecutiveFailures: 0,
        lastExtensionMessageAt: 42,
        session: { state: 'linked', pairCode: null, extensionConnected: true },
      } as never;
    },
  } as Pick<FetchproxyTransport, 'runProbe' | 'status'>;
}

function blocked(): EdgeBlockedError {
  return new EdgeBlockedError(403, 'Cloudflare', { service: 'Hemnet GraphQL', method: 'POST', path: '/graphql' });
}

function setup(opts: {
  direct?: (q: string) => Promise<string>;
  bridge?: (q: string) => Promise<string>;
  mode?: 'direct' | 'fetchproxy' | 'auto';
} = {}) {
  const directCall = vi.fn(opts.direct ?? (async (q: string) => `direct:${q}`));
  const bridgeCall = vi.fn(opts.bridge ?? (async (q: string) => `bridge:${q}`));
  const health = healthSlice();
  const direct: Leg = { name: 'direct', graphql: directCall };
  const bridgeFactory = vi.fn((): Leg => ({ name: 'bridge', graphql: bridgeCall, bridgeTransport: () => health }));
  const log = vi.fn();
  const fb = createDirectFirstTransport<Leg>({
    direct,
    bridge: bridgeFactory,
    serverName: 'hemnet-mcp',
    hostLabel: 'www.hemnet.se',
    ...(opts.mode ? { mode: opts.mode } : {}),
    log,
  });
  const graphql = (q: string, signal?: AbortSignal) =>
    fb.run((leg) => leg.graphql(q), signal ? { signal } : {});
  return { fb, graphql, directCall, bridgeCall, bridgeFactory, health, log };
}

describe('readTransportMode', () => {
  it('defaults to auto when the variable is unset', () => {
    expect(readTransportMode('HEMNET_TRANSPORT', { env: {} })).toBe('auto');
  });

  it('honours each known mode, case- and whitespace-insensitively', () => {
    expect(readTransportMode('X_TRANSPORT', { env: { X_TRANSPORT: 'direct' } })).toBe('direct');
    expect(readTransportMode('X_TRANSPORT', { env: { X_TRANSPORT: ' FetchProxy ' } })).toBe('fetchproxy');
    expect(readTransportMode('X_TRANSPORT', { env: { X_TRANSPORT: 'auto' } })).toBe('auto');
  });

  it('treats an unexpanded placeholder as unset (hardened readEnvVar)', () => {
    expect(readTransportMode('X_TRANSPORT', { env: { X_TRANSPORT: '${X_TRANSPORT}' } })).toBe('auto');
  });

  it('warns on an unknown value, naming the variable, and falls back to the default', () => {
    const log = vi.fn();
    expect(readTransportMode('BOOLI_TRANSPORT', { env: { BOOLI_TRANSPORT: 'bridge' }, log })).toBe('auto');
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatch(/Unknown BOOLI_TRANSPORT value "bridge"/);
  });

  it('takes a different default', () => {
    expect(readTransportMode('X_TRANSPORT', { env: {}, default: 'direct' })).toBe('direct');
  });
});

describe('createDirectFirstTransport — auto mode', () => {
  it('rides the direct leg while it answers, never building the bridge', async () => {
    const { fb, graphql, bridgeFactory } = setup();
    await expect(graphql('q1')).resolves.toBe('direct:q1');
    expect(bridgeFactory).not.toHaveBeenCalled();
    expect(fb.status()).toEqual({ transport: 'direct', mode: 'auto' });
    expect(fb.bridgeTransport()).toBeUndefined();
  });

  it('on an EdgeBlockedError re-runs the same call on the bridge and stays there', async () => {
    const { fb, graphql, directCall, bridgeCall, bridgeFactory, health, log } = setup({
      direct: async () => {
        throw blocked();
      },
    });
    await expect(graphql('q1')).resolves.toBe('bridge:q1');
    await expect(graphql('q2')).resolves.toBe('bridge:q2');
    // Sticky: the wall fingerprints the client, so direct is not re-probed.
    expect(directCall).toHaveBeenCalledTimes(1);
    expect(bridgeCall).toHaveBeenCalledTimes(2);
    expect(bridgeFactory).toHaveBeenCalledTimes(1);
    expect(fb.status()).toEqual({ transport: 'fetchproxy', mode: 'auto', blocked_by: 'Cloudflare' });
    expect(fb.bridgeTransport()).toBe(health);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatch(/^\[hemnet-mcp\] Direct fetch was refused by Cloudflare/);
    expect(log.mock.calls[0]![0]).toMatch(/www\.hemnet\.se tab/);
  });

  it('falls back on edge-block EVIDENCE too — a refusal page or cf-mitigated on any error', async () => {
    const page = setup({
      direct: async () => {
        throw new FetchproxyHttpError({ status: 403, body: CLOUDFLARE_CHALLENGE, url: 'https://x' } as never);
      },
    });
    await expect(page.graphql('q')).resolves.toBe('bridge:q');

    const header = setup({
      direct: async () => {
        throw Object.assign(new Error('HTTP 403'), { status: 403, headers: { 'cf-mitigated': 'challenge' } });
      },
    });
    await expect(header.graphql('q')).resolves.toBe('bridge:q');
  });

  it('propagates any other direct failure without switching or building the bridge', async () => {
    const boom = new Error('fetch failed');
    const { fb, graphql, bridgeFactory } = setup({
      direct: async () => {
        throw boom;
      },
    });
    await expect(graphql('q')).rejects.toBe(boom);
    expect(bridgeFactory).not.toHaveBeenCalled();
    expect(fb.status()).toEqual({ transport: 'direct', mode: 'auto' });
  });

  it('builds the bridge once when concurrent calls are walled together', async () => {
    const { graphql, bridgeFactory, log } = setup({
      direct: async () => {
        throw blocked();
      },
    });
    const results = await Promise.all([graphql('a'), graphql('b'), graphql('c')]);
    expect(results).toEqual(['bridge:a', 'bridge:b', 'bridge:c']);
    expect(bridgeFactory).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledOnce();
  });

  it('surfaces the bridge error itself (typed, for the healthcheck) when the bridge is down', async () => {
    const down = new FetchproxyBridgeDownError({ originalError: 'no SW', op: 'fetch', role: 'host', port: 37149 });
    const { fb, graphql } = setup({
      direct: async () => {
        throw blocked();
      },
      bridge: async () => {
        throw down;
      },
    });
    await expect(graphql('q')).rejects.toBe(down);
    // Still on the bridge: the wall did not go away because the bridge is down.
    expect(fb.status().transport).toBe('fetchproxy');
  });

  it('retries a bridge factory that threw on the next call instead of caching the failure', async () => {
    let attempts = 0;
    const fb = createDirectFirstTransport<Leg>({
      direct: { name: 'direct', graphql: async () => Promise.reject(blocked()) },
      bridge: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('could not load identity');
        return { name: 'bridge', graphql: async (q) => `bridge:${q}` };
      },
      serverName: 'booli-mcp',
      log: () => {},
    });
    await expect(fb.run((l) => l.graphql('q'))).rejects.toThrow(/could not load identity/);
    await expect(fb.run((l) => l.graphql('q'))).resolves.toBe('bridge:q');
    expect(attempts).toBe(2);
  });

  it('accepts a custom shouldFallBack (a repo-local challenge error during migration)', async () => {
    class CloudflareChallengeError extends Error {}
    const fb = createDirectFirstTransport<Leg>({
      direct: { name: 'direct', graphql: async () => Promise.reject(new CloudflareChallengeError('walled')) },
      bridge: () => ({ name: 'bridge', graphql: async () => 'bridge' }),
      serverName: 'booli-mcp',
      shouldFallBack: (err) => err instanceof CloudflareChallengeError,
      log: () => {},
    });
    await expect(fb.run((l) => l.graphql(''))).resolves.toBe('bridge');
    // No vendor is known for a consumer-judged block.
    expect(fb.status()).toEqual({ transport: 'fetchproxy', mode: 'auto' });
  });

  it('hands the switch to onFallback instead of logging, with the error and vendor', async () => {
    const onFallback = vi.fn();
    const err = blocked();
    const log = vi.fn();
    const fb = createDirectFirstTransport<Leg>({
      direct: { name: 'direct', graphql: async () => Promise.reject(err) },
      bridge: () => ({ name: 'bridge', graphql: async () => 'bridge' }),
      serverName: 'hemnet-mcp',
      onFallback,
      log,
    });
    await fb.run((l) => l.graphql(''));
    expect(onFallback).toHaveBeenCalledWith({ error: err, vendor: 'Cloudflare' });
    expect(log).not.toHaveBeenCalled();
  });

  it('tells the call which leg it is on', async () => {
    const { fb } = setup({
      direct: async () => {
        throw blocked();
      },
    });
    const seen: string[] = [];
    await fb.run(async (leg, ctx) => {
      seen.push(ctx.leg);
      return leg.graphql('q');
    });
    expect(seen).toEqual(['direct', 'fetchproxy']);
  });
});

describe('createDirectFirstTransport — pinned modes', () => {
  it('mode=direct never falls back: the edge block propagates and no bridge is built', async () => {
    const err = blocked();
    const { fb, graphql, bridgeFactory } = setup({
      mode: 'direct',
      direct: async () => {
        throw err;
      },
    });
    await expect(graphql('q')).rejects.toBe(err);
    expect(bridgeFactory).not.toHaveBeenCalled();
    expect(fb.status()).toEqual({ transport: 'direct', mode: 'direct' });
    expect(fb.bridgeTransport()).toBeUndefined();
  });

  it('mode=fetchproxy rides the bridge from the first call and never touches direct', async () => {
    const { fb, graphql, directCall, health } = setup({ mode: 'fetchproxy' });
    expect(fb.status()).toEqual({ transport: 'fetchproxy', mode: 'fetchproxy' });
    // The healthcheck can project the bridge before any call has built it.
    expect(fb.bridgeTransport()).toBe(health);
    await expect(graphql('q')).resolves.toBe('bridge:q');
    expect(directCall).not.toHaveBeenCalled();
  });
});

describe('createDirectFirstTransport — bridge health projection', () => {
  it('uses the bridge itself when it IS a health slice (runProbe + status)', async () => {
    const slice = healthSlice();
    const bridge = Object.assign(slice, { graphql: async () => 'b', name: 'bridge' });
    const fb = createDirectFirstTransport<Leg>({
      direct: { name: 'direct', graphql: async () => Promise.reject(blocked()) },
      bridge: () => bridge,
      serverName: 'x-mcp',
      log: () => {},
    });
    await fb.run((l) => l.graphql(''));
    expect(fb.bridgeTransport()).toBe(bridge);
  });

  it('takes an explicit bridgeHealth projection', async () => {
    const slice = healthSlice(40000);
    const fb = createDirectFirstTransport<Leg, Leg & { inner: BridgeHealthcheckTransport }>({
      direct: { name: 'direct', graphql: async () => Promise.reject(blocked()) },
      bridge: () => ({ name: 'bridge', graphql: async () => 'b', inner: slice }),
      bridgeHealth: (b) => b.inner,
      serverName: 'x-mcp',
      log: () => {},
    });
    await fb.run((l) => l.graphql(''));
    expect(fb.bridgeTransport()).toBe(slice);
  });
});

describe('createDirectFirstTransport — cancellation', () => {
  it('a call cancelled before it starts runs neither leg', async () => {
    const { graphql, directCall, bridgeFactory } = setup();
    const ac = new AbortController();
    ac.abort(new Error('caller went away'));
    await expect(graphql('q', ac.signal)).rejects.toThrow('caller went away');
    expect(directCall).not.toHaveBeenCalled();
    expect(bridgeFactory).not.toHaveBeenCalled();
  });

  it('a call cancelled while on the direct leg is not re-sent over the bridge', async () => {
    const ac = new AbortController();
    const { graphql, bridgeCall } = setup({
      direct: async () => {
        ac.abort(new Error('cancelled'));
        throw blocked();
      },
    });
    await expect(graphql('q', ac.signal)).rejects.toThrow('cancelled');
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('still records the wall it saw, so the NEXT call goes to the bridge', async () => {
    const ac = new AbortController();
    const { fb, graphql, directCall } = setup({
      direct: async () => {
        ac.abort(new Error('cancelled'));
        throw blocked();
      },
    });
    await expect(graphql('q', ac.signal)).rejects.toThrow('cancelled');
    expect(fb.status().transport).toBe('fetchproxy');
    await expect(graphql('q2')).resolves.toBe('bridge:q2');
    expect(directCall).toHaveBeenCalledTimes(1);
  });

  it('honours the ambient tool-call signal without threading it', async () => {
    const ac = new AbortController();
    const { graphql, bridgeCall } = setup({
      direct: async () => {
        ac.abort(new Error('client sent notifications/cancelled'));
        throw blocked();
      },
    });
    await expect(withCallSignal(ac.signal, () => graphql('q'))).rejects.toThrow(/notifications\/cancelled/);
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('passes the effective signal to the call', async () => {
    const ac = new AbortController();
    const { fb } = setup();
    let seen: AbortSignal | undefined;
    await fb.run(async (leg, ctx) => {
      seen = ctx.signal;
      return leg.graphql('q');
    }, { signal: ac.signal });
    expect(seen).toBe(ac.signal);
  });
});

describe('createDirectFirstTransport — stats', () => {
  it('starts empty', () => {
    const { fb } = setup();
    expect(fb.stats()).toEqual({
      requests: { direct: 0, fetchproxy: 0 },
      failures: { direct: 0, fetchproxy: 0 },
      edge_blocks: 0,
      switched_at: null,
    });
  });

  it('counts each leg attempt, each failure, and the edge block that switched it', async () => {
    let n = 0;
    const { fb, graphql } = setup({
      direct: async (q) => {
        n += 1;
        if (n === 1) return `direct:${q}`;
        if (n === 2) throw new Error('fetch failed');
        throw blocked();
      },
      bridge: async (q) => {
        if (q === 'bad') throw new Error('bridge http 500');
        return `bridge:${q}`;
      },
    });
    await graphql('ok'); // direct ok
    await graphql('net').catch(() => {}); // direct fails (not a wall)
    await graphql('walled'); // direct walled → bridge ok
    await graphql('bad').catch(() => {}); // bridge fails
    await graphql('ok2'); // bridge ok
    const s = fb.stats();
    expect(s.requests).toEqual({ direct: 3, fetchproxy: 3 });
    expect(s.failures).toEqual({ direct: 2, fetchproxy: 1 });
    expect(s.edge_blocks).toBe(1);
    expect(typeof s.switched_at).toBe('number');
  });

  it('returns a snapshot, not a live object', async () => {
    const { fb, graphql } = setup();
    const before = fb.stats();
    await graphql('q');
    expect(before.requests.direct).toBe(0);
    expect(fb.stats().requests.direct).toBe(1);
  });
});

describe('createDirectFirstTransport + registerBridgeHealthcheckTool', () => {
  type Body = {
    ok: boolean;
    transport?: Record<string, unknown>;
    bridge?: Record<string, unknown>;
    error?: { kind: string; message: string; detail?: Record<string, unknown> };
    hint: string;
  };

  async function healthcheck(fb: ReturnType<typeof setup>['fb'], probe: () => Promise<string>): Promise<Body> {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'hemnet',
        probePath: '/graphql',
        hostLabel: 'www.hemnet.se',
        transport: () => fb.bridgeTransport(),
        path: () => fb.status(),
        probeFn: probe,
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('hemnet_healthcheck', {}));
    await harness.close();
    return body;
  }

  it('auto: the probe that hits the wall flips to the bridge and reports it, no classifier needed', async () => {
    const { fb } = setup({
      direct: async () => {
        throw blocked();
      },
    });
    const body = await healthcheck(fb, () => fb.run((l) => l.graphql('probe')));
    expect(body.ok).toBe(true);
    expect(body.transport).toEqual({ transport: 'fetchproxy', mode: 'auto', blocked_by: 'Cloudflare' });
    expect(body.bridge?.session_state).toBe('linked');
  });

  it('pinned direct: the wall is edge_blocked with the direct-leg hint, no classifier needed', async () => {
    const { fb } = setup({
      mode: 'direct',
      direct: async () => {
        throw blocked();
      },
    });
    const body = await healthcheck(fb, () => fb.run((l) => l.graphql('probe')));
    expect(body.ok).toBe(false);
    expect(body.error?.kind).toBe('edge_blocked');
    expect(body.error?.detail).toEqual({ vendor: 'Cloudflare' });
    expect(body.hint).toMatch(/ContextMint Bridge/);
  });
});

describe('runBridgeHealthcheck — sees through a wrapping error to the typed bridge cause', () => {
  // hemnet / booli re-throw bridge failures as `new Error('<Site> bridge: …',
  // { cause: typed })` to put the remediation in the message; the raw
  // classifier only reads the outer error, so each repo hand-rolled a
  // `classifyThrown` that unwrapped `cause`. The shared healthcheck now does.
  type Body = { ok: boolean; error?: { kind: string; message: string; bridge_hint?: string; detail?: Record<string, unknown> }; hint: string };

  async function probeThrowing(err: unknown): Promise<Body> {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'booli',
        probePath: '/graphql',
        hostLabel: 'www.booli.se',
        transport: () => healthSlice(),
        path: () => ({ transport: 'fetchproxy', mode: 'auto' }),
        probeFn: async () => {
          throw err;
        },
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('booli_healthcheck', {}));
    await harness.close();
    return body;
  }

  const wrap = (cause: unknown) => new Error('Booli bridge: something failed. Open a tab.', { cause });

  it('session_not_ready, with its hint, through one wrapper', async () => {
    const inner = new FetchproxySessionNotReadyError({ mcpId: 'booli-mcp:0.3.0:abc', pairCode: '123456' });
    const body = await probeThrowing(wrap(inner));
    expect(body.error?.kind).toBe('session_not_ready');
    expect(body.error?.message).toMatch(/^Booli bridge:/);
    expect(body.error?.bridge_hint).toBe(inner.hint);
  });

  it('bridge_down through two wrappers', async () => {
    const inner = new FetchproxyBridgeDownError({ originalError: 'no SW', op: 'fetch', role: 'host', port: 37149 });
    const body = await probeThrowing(wrap(wrap(inner)));
    expect(body.error?.kind).toBe('bridge_down');
  });

  it('http for an upstream non-2xx answered through the bridge', async () => {
    const body = await probeThrowing(wrap(new FetchproxyHttpError({ status: 500, body: 'oops', url: 'https://x' } as never)));
    expect(body.error?.kind).toBe('http');
  });

  it('edge_blocked (with the vendor) for an EdgeBlockedError cause', async () => {
    const body = await probeThrowing(
      wrap(new EdgeBlockedError(200, 'Cloudflare', { service: 'Booli GraphQL', method: 'POST', path: '/graphql' })),
    );
    expect(body.error?.kind).toBe('edge_blocked');
    expect(body.error?.detail).toEqual({ vendor: 'Cloudflare' });
  });

  it('leaves an unclassifiable chain as unknown', async () => {
    const body = await probeThrowing(wrap(new Error('nothing typed here')));
    expect(body.error?.kind).toBe('unknown');
  });

  it('does not loop on a cyclic cause chain', async () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    const body = await probeThrowing(a);
    expect(body.error?.kind).toBe('unknown');
  });

  it('on the bridge-only route too (runProbe filed the wrapper as other)', async () => {
    const inner = new FetchproxyBridgeDownError({ originalError: 'no SW', op: 'fetch', role: 'host', port: 37149 });
    const transport: BridgeHealthcheckTransport = {
      async runProbe(fetchFn, p) {
        try {
          await fetchFn(p);
        } catch {
          /* classified below */
        }
        return {
          ok: false,
          elapsed_ms: 1,
          bridge: {
            role: 'host',
            port: 37149,
            server_version: '3.3.0',
            fetch_timeout_ms: 30000,
            last_success_at: null,
            last_failure_at: 1,
            last_failure_reason: 'other',
            consecutive_failures: 1,
          },
          error: { kind: 'other', message: 'Booli bridge: down' },
        } as never;
      },
      status: healthSlice().status,
    };
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'booli',
        probePath: '/graphql',
        hostLabel: 'www.booli.se',
        transport,
        probeFn: async () => {
          throw wrap(inner);
        },
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('booli_healthcheck', {}));
    await harness.close();
    expect(body.error?.kind).toBe('bridge_down');
  });
});
