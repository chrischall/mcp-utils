import { describe, expect, it } from 'vitest';

import {
  registerBridgeHealthcheckTool,
  type BridgeProbeResult,
  type FetchproxyTransport,
} from './index.js';
import { createTestHarness, parseToolResult } from '../test/index.js';

// Minimal fake transport mirroring index.test.ts's harness: runProbe invokes
// the fetchFn (so the consumer's wrapper captures a throw) and returns the
// canned probe result; status() supplies the liveness counter.
function fakeTransport(
  probeResult: BridgeProbeResult,
): Pick<FetchproxyTransport, 'runProbe' | 'status'> {
  return {
    async runProbe(fetchFn, probePath) {
      try {
        await fetchFn(probePath);
      } catch {
        /* classified into probeResult.error by the real runProbe */
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
        lastExtensionMessageAt: null,
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

const failedProbe = (kind: 'timeout' | 'protocol'): BridgeProbeResult => ({
  ok: false,
  elapsed_ms: 5,
  bridge: {
    role: 'host',
    port: 37149,
    server_version: '1.0.0',
    fetch_timeout_ms: 30000,
    last_success_at: null,
    last_failure_at: Date.now(),
    last_failure_reason: kind,
    consecutive_failures: 1,
  },
  error: { kind, message: `probe ${kind}` },
});

class SessionExpiredProbeError extends Error {
  constructor() {
    super('SSO bounce detected');
    this.name = 'SessionExpiredProbeError';
  }
}

describe('registerBridgeHealthcheckTool custom hooks', () => {
  it('classifyThrown can re-kind an error (workday session_expired) and set the hint', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'workday',
        probePath: '/home.htmld',
        hostLabel: 'wd5.myworkday.com',
        transport: fakeTransport(failedProbe('protocol')),
        probeFn: async () => {
          throw new SessionExpiredProbeError();
        },
        classifyThrown: (err) =>
          err instanceof SessionExpiredProbeError
            ? { kind: 'session_expired', hint: 'Re-sign in to Workday via your company SSO, then retry.' }
            : undefined,
      }),
    );
    const res = parseToolResult<{ ok: boolean; error?: { kind: string }; hint: string }>(
      await harness.callTool('workday_healthcheck'),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('session_expired');
    expect(res.hint).toContain('company SSO');
    await harness.close();
  });

  it('hints overrides replace the default copy for that arm', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'etix',
        probePath: '/robots.txt',
        hostLabel: 'www.etix.com',
        transport: fakeTransport(failedProbe('timeout')),
        probeFn: async () => {
          throw new Error('timed out');
        },
        hints: { timeout: 'DataDome may be challenging the tab — reload a signed-in etix.com tab and retry.' },
      }),
    );
    const res = parseToolResult<{ hint: string }>(await harness.callTool('etix_healthcheck'));
    expect(res.hint).toBe(
      'DataDome may be challenging the tab — reload a signed-in etix.com tab and retry.',
    );
    await harness.close();
  });

  it('without hooks, behavior is unchanged (default ladder)', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'compass',
        probePath: '/robots.txt',
        hostLabel: 'compass.com',
        transport: fakeTransport(failedProbe('timeout')),
        probeFn: async () => {
          throw new Error('timed out');
        },
      }),
    );
    const res = parseToolResult<{ hint: string; error?: { kind: string } }>(
      await harness.callTool('compass_healthcheck'),
    );
    expect(res.error?.kind).toBe('timeout');
    expect(res.hint).toMatch(/extension isn't connected|sleeping/);
    await harness.close();
  });
});

describe('registerBridgeHealthcheckTool classifyThrown detail', () => {
  it('merges a classifyThrown-supplied detail object into the error', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'zillow',
        probePath: '/robots.txt',
        hostLabel: 'www.zillow.com',
        transport: fakeTransport(failedProbe('timeout')),
        probeFn: async () => {
          throw new Error('timed out');
        },
        classifyThrown: () => ({
          kind: 'timeout',
          detail: { elapsed_ms_at_timeout: 30000, retry_attempted: true, role_at_failure: 'host' },
        }),
      }),
    );
    const res = parseToolResult<{
      error?: { kind: string; detail?: { elapsed_ms_at_timeout?: number; retry_attempted?: boolean } };
    }>(await harness.callTool('zillow_healthcheck'));
    expect(res.error?.kind).toBe('timeout');
    expect(res.error?.detail?.elapsed_ms_at_timeout).toBe(30000);
    expect(res.error?.detail?.retry_attempted).toBe(true);
    await harness.close();
  });

  it('omits detail when no classifyThrown is supplied at all', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'etix',
        probePath: '/robots.txt',
        hostLabel: 'www.etix.com',
        transport: fakeTransport(failedProbe('timeout')),
        probeFn: async () => {
          throw new Error('timed out');
        },
      }),
    );
    const res = parseToolResult<{ error?: { kind: string; detail?: unknown } }>(
      await harness.callTool('etix_healthcheck'),
    );
    expect(res.error?.detail).toBeUndefined();
    await harness.close();
  });

  it('omits detail when classifyThrown IS supplied but returns no detail', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'etix',
        probePath: '/robots.txt',
        hostLabel: 'www.etix.com',
        transport: fakeTransport(failedProbe('timeout')),
        probeFn: async () => {
          throw new Error('timed out');
        },
        // Re-kinds + supplies a hint, but no detail — error.detail must stay absent.
        classifyThrown: () => ({ kind: 'bot_wall', hint: 'DataDome may be challenging the tab.' }),
      }),
    );
    const res = parseToolResult<{ error?: { kind: string; detail?: unknown }; hint: string }>(
      await harness.callTool('etix_healthcheck'),
    );
    expect(res.error?.kind).toBe('bot_wall');
    expect(res.error?.detail).toBeUndefined();
    expect(res.hint).toContain('DataDome');
    await harness.close();
  });
});
