/**
 * @fetchproxy 3.3+ (#418): a browser that cannot serve a verb
 * (`capability_unavailable` — Safari has no downloads) versus an MCP that
 * called a capability it never declared (`capability_denied`), plus the
 * user-facing name of the extension: ContextMint Bridge.
 *
 * Detection is by the server's classifiers AND duck-typing, because a consumer
 * may have a pre-3.3 `@fetchproxy/server` installed (where the same wire error
 * is a bare `FetchproxyProtocolError` and `classifyBridgeError` says
 * `'protocol'`) — so these tests build the errors both ways.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  FetchproxyCapabilityUnavailableError,
  FetchproxyHelloRejectedError,
  protocolErrorFrom,
  type BridgeProbeResult,
} from '@fetchproxy/server';

import {
  bridgeErrorInfo,
  registerBridgeHealthcheckTool,
  FetchproxyProtocolError,
  FetchproxyTimeoutError,
  FetchproxyHttpError,
  type FetchproxyTransport,
} from './index.js';
import { createTestHarness, parseToolResult } from '../test/index.js';

const WIRE = 'capability "download" is not available in this browser (safari)';

describe('bridgeErrorInfo — capability_unavailable', () => {
  it('classifies the typed 3.3+ error, naming the browser and the capability, and not blaming the MCP', () => {
    const err = new FetchproxyCapabilityUnavailableError(WIRE, { capability: 'download', platform: 'safari' });
    const out = bridgeErrorInfo(err);
    expect(out.type).toBe('capability_unavailable');
    expect(out.hint).toMatch(/safari/);
    expect(out.hint).toMatch(/"download"/);
    expect(out.hint).toMatch(/Chrome/);
    expect(out.hint).toMatch(/isn't at fault/);
    // The server folds its own hint into the message; the envelope keeps the
    // wire error as the message so a consumer appending `hint` doesn't repeat it.
    expect(out.message).toBe(WIRE);
  });

  it('says "this browser" without a platform when the extension did not name one', () => {
    const err = new FetchproxyCapabilityUnavailableError('capability "download" is not available in this browser', {
      capability: 'download',
      platform: null,
    });
    const out = bridgeErrorInfo(err);
    expect(out.type).toBe('capability_unavailable');
    expect(out.hint).toMatch(/^This browser can't/);
    expect(out.hint).not.toMatch(/\(null\)/);
  });

  it('is what protocolErrorFrom builds from a wire `code` with no fixed wording', () => {
    const err = protocolErrorFrom('something new', undefined, { code: 'capability_unavailable', op: 'graphql_query' });
    const out = bridgeErrorInfo(err);
    expect(out.type).toBe('capability_unavailable');
    expect(out.hint).toMatch(/"graphql"/);
  });

  it('recognises the fixed wording on a bare protocol error (a pre-3.3 server)', () => {
    const out = bridgeErrorInfo(new FetchproxyProtocolError(WIRE));
    expect(out.type).toBe('capability_unavailable');
    expect(out.hint).toMatch(/safari/);
    expect(out.hint).toMatch(/"download"/);
  });

  it('recognises a `code: capability_unavailable` on any error', () => {
    const err = Object.assign(new Error('refused'), { code: 'capability_unavailable' });
    expect(bridgeErrorInfo(err).type).toBe('capability_unavailable');
  });

  it('recognises the class by name when it comes from another copy of @fetchproxy/server', () => {
    const err = Object.assign(new Error(`${WIRE} — whatever`), {
      name: 'FetchproxyCapabilityUnavailableError',
      originalError: WIRE,
      capability: 'download',
      platform: 'safari',
    });
    const out = bridgeErrorInfo(err);
    expect(out.type).toBe('capability_unavailable');
    expect(out.message).toBe(WIRE);
  });

  it('classifies an `unsupported-capability:` hello rejection, naming every capability', () => {
    const err = new FetchproxyHelloRejectedError({
      mcpId: 'x-mcp:1.0.0:abc',
      reason: 'unsupported-capability: download, graphql (not available in this browser)',
      platform: 'safari',
    });
    const out = bridgeErrorInfo(err);
    expect(out.type).toBe('capability_unavailable');
    expect(out.hint).toMatch(/safari/);
    expect(out.hint).toMatch(/"download", "graphql"/);
  });

  it('leaves an unrelated hello rejection alone', () => {
    const err = new FetchproxyHelloRejectedError({ mcpId: 'x', reason: 'revoked' });
    expect(bridgeErrorInfo(err).type).not.toBe('capability_unavailable');
  });
});

describe('bridgeErrorInfo — capability_denied', () => {
  it('blames the MCP (a bug to report), not the browser', () => {
    const out = bridgeErrorInfo(new FetchproxyProtocolError('capability read_cookies not granted to this MCP'));
    expect(out.type).toBe('capability_denied');
    expect(out.hint).toMatch(/never declared/);
    expect(out.hint).toMatch(/bug in the MCP/);
    expect(out.hint).toMatch(/report/i);
  });

  it('leaves an upstream HTTP error alone even when its body quotes the wording', () => {
    const err = new FetchproxyHttpError(
      { status: 403, statusText: 'x', url: 'https://x', body: '', headers: {} } as never,
      'upstream 403: capability admin not granted; capability "x" is not available in this browser',
    );
    expect(bridgeErrorInfo(err).type).toBe('http');
  });

  it('does not mistake the unavailable wording for a denial', () => {
    expect(bridgeErrorInfo(new FetchproxyProtocolError(WIRE)).type).toBe('capability_unavailable');
  });
});

describe('bridgeErrorInfo — ContextMint Bridge wording', () => {
  it('names ContextMint Bridge, never Transporter or "the fetchproxy extension"', () => {
    const hints = [
      bridgeErrorInfo(
        new FetchproxyTimeoutError({ url: 'https://x', timeoutMs: 1, elapsedMs: 2, role: 'host', port: 1 }),
      ).hint,
      bridgeErrorInfo(new FetchproxyProtocolError('no_tab')).hint,
    ];
    // (bridge_down surfaces the server's own `FetchproxyBridgeDownError.hint`
    // verbatim — its wording is @fetchproxy/server's, not ours.)
    expect(hints[0]).toMatch(/ContextMint Bridge/);
    expect(hints[1]).toMatch(/ContextMint Bridge/);
    for (const h of hints) {
      expect(h).not.toMatch(/Transporter|fetchproxy (browser )?(extension|bridge)/i);
    }
  });
});

describe('registerBridgeHealthcheckTool — capability_unavailable', () => {
  const probeResult = (extra: Record<string, unknown> = {}): BridgeProbeResult =>
    ({
      ok: false,
      elapsed_ms: 5,
      bridge: {
        role: 'host',
        port: 37149,
        server_version: '3.4.0',
        fetch_timeout_ms: 30000,
        last_success_at: null,
        last_failure_at: null,
        last_failure_reason: null,
        consecutive_failures: 1,
        ...extra,
      },
      // What classifyBridgeError says for this error in 3.4.0.
      error: { kind: 'protocol', message: WIRE },
    }) as BridgeProbeResult;

  function transport(result: BridgeProbeResult): Pick<FetchproxyTransport, 'runProbe' | 'status'> {
    return {
      async runProbe(fetchFn, p) {
        try {
          await fetchFn(p);
        } catch {
          /* classified into result.error */
        }
        return result;
      },
      status() {
        return { lastExtensionMessageAt: null } as never;
      },
    };
  }

  const throwsUnavailable = async (): Promise<string> => {
    throw new FetchproxyCapabilityUnavailableError(WIRE, { capability: 'download', platform: 'safari' });
  };

  type Body = {
    ok: boolean;
    bridge?: Record<string, unknown>;
    error?: { kind: string };
    hint: string;
  };

  it('re-kinds the probe error and gives the browser-gap hint', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'svc',
        probePath: '/robots.txt',
        hostLabel: 'svc.example',
        transport: transport(probeResult()),
        probeFn: throwsUnavailable,
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('svc_healthcheck', {}));
    await harness.close();
    expect(body.error?.kind).toBe('capability_unavailable');
    expect(body.hint).toMatch(/safari/);
    expect(body.hint).toMatch(/Chrome/);
  });

  it('a `hints.capability_unavailable` override replaces the copy', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'svc',
        probePath: '/robots.txt',
        hostLabel: 'svc.example',
        transport: transport(probeResult()),
        probeFn: throwsUnavailable,
        hints: { capability_unavailable: 'custom' },
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('svc_healthcheck', {}));
    await harness.close();
    expect(body.hint).toBe('custom');
  });

  it('passes the session unavailable_capabilities / platform through on the path route', async () => {
    const bridge: Pick<FetchproxyTransport, 'runProbe' | 'status'> = {
      async runProbe() {
        throw new Error('unused');
      },
      status() {
        return {
          role: 'host',
          port: 37149,
          serverVersion: '3.4.0',
          fetchTimeoutMs: 30000,
          lastSuccessAt: 1,
          lastFailureAt: null,
          lastFailureReason: null,
          consecutiveFailures: 0,
          lastExtensionMessageAt: 42,
          session: {
            state: 'linked',
            pairCode: null,
            extensionConnected: true,
            unavailableCapabilities: ['download'],
            platform: 'safari',
          },
        } as never;
      },
    };
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'svc',
        probePath: '/robots.txt',
        hostLabel: 'svc.example',
        transport: () => bridge,
        path: () => ({ transport: 'fetchproxy' }),
        probeFn: async () => 'ok',
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('svc_healthcheck', {}));
    await harness.close();
    expect(body.bridge).toMatchObject({ unavailable_capabilities: ['download'], platform: 'safari' });
  });

  it('uses the session platform in the hint when the error does not name one', async () => {
    const harness = await createTestHarness((server) =>
      registerBridgeHealthcheckTool({
        server,
        prefix: 'svc',
        probePath: '/robots.txt',
        hostLabel: 'svc.example',
        transport: transport(probeResult({ unavailable_capabilities: ['download'], platform: 'safari' })),
        probeFn: async () => {
          throw new FetchproxyCapabilityUnavailableError('capability "download" is not available in this browser', {
            capability: 'download',
            platform: null,
          });
        },
      }),
    );
    const body = parseToolResult<Body>(await harness.callTool('svc_healthcheck', {}));
    await harness.close();
    expect(body.bridge).toMatchObject({ unavailable_capabilities: ['download'], platform: 'safari' });
    expect(body.hint).toMatch(/\(safari\)/);
  });
});

describe('registerBridgeHealthcheckTool — ContextMint Bridge wording', () => {
  it('the tool title and description name ContextMint Bridge', () => {
    // The in-memory harness lists only name + description, so read the
    // registration itself to see the title too.
    const registerTool = vi.fn();
    registerBridgeHealthcheckTool({
      server: { registerTool } as never,
      prefix: 'svc',
      probePath: '/robots.txt',
      hostLabel: 'svc.example',
      transport: { runProbe: async () => ({}) as never, status: () => ({}) as never },
      probeFn: async () => 'ok',
    });
    const config = registerTool.mock.calls[0]![1] as {
      title: string;
      description: string;
      annotations: { title: string };
    };
    for (const text of [config.title, config.annotations.title, config.description]) {
      expect(text).toMatch(/ContextMint Bridge/);
      expect(text).not.toMatch(/Transporter|fetchproxy/i);
    }
  });
});
