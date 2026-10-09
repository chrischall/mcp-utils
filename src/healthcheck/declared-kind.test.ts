/**
 * The credential healthcheck reads a thrown error's declared `kind` (and a
 * status off its `cause` chain) before falling back to the status ladder and
 * message matching — so a connector that wraps an `ApiError` in an
 * `McpToolError` for its hint no longer loses the 401 and lands on `unknown`
 * (fleet audit 2026-09, cluster 8).
 */
import { describe, expect, it } from 'vitest';

import { registerCredentialHealthcheckTool } from './index.js';
import { McpToolError, SessionNotAuthenticatedError } from '../errors/index.js';
import { OAuth2RefreshError } from '../auth/index.js';
import { createTestHarness, parseToolResult } from '../test/index.js';

interface Result {
  ok: boolean;
  credential: { source: string | null; resolved: boolean };
  probe: { url?: string; elapsed_ms: number; status?: number };
  error?: { kind: string; message: string; detail?: Record<string, unknown> };
  hint: string;
}

async function run(args: Omit<Parameters<typeof registerCredentialHealthcheckTool>[0], 'server' | 'prefix' | 'hostLabel'>) {
  const h = await createTestHarness((server) =>
    registerCredentialHealthcheckTool({ prefix: 'demo', hostLabel: 'api.demo.com', ...args, server }),
  );
  const res = await h.client.callTool({ name: 'demo_healthcheck', arguments: {} });
  await h.close?.();
  return parseToolResult<Result>(res as never);
}

const resolved = async () => ({ source: 'env' });
const failingProbe = (err: unknown) => async () => {
  throw err;
};

describe('probe path: a declared kind decides before the status ladder', () => {
  it('a kind with no status (SessionNotAuthenticatedError) is its arm, not unknown', async () => {
    const r = await run({ resolveCredential: resolved, probeFn: failingProbe(new SessionNotAuthenticatedError('Demo')) });
    expect(r.error?.kind).toBe('session_expired');
    expect(r.hint).toMatch(/no session is live/);
  });

  it('a kind beats a status: a 400 rejected grant is credential_rejected, not http', async () => {
    const r = await run({ resolveCredential: resolved, probeFn: failingProbe(new OAuth2RefreshError(400, 'invalid_grant')) });
    expect(r.error?.kind).toBe('credential_rejected');
    expect(r.probe.status).toBe(400);
  });

  it('a kind is read instead of the message (no regex over "assignment failed")', async () => {
    const r = await run({
      resolveCredential: resolved,
      probeFn: failingProbe(new McpToolError('assignment sign-in timed out', { kind: 'transport' })),
    });
    expect(r.error?.kind).toBe('transport');
  });

  it('a kind outside the vocabulary is ignored and the ladder runs', async () => {
    const r = await run({
      resolveCredential: resolved,
      probeFn: failingProbe(Object.assign(new Error('x'), { kind: 'bridge_down', status: 503 })),
    });
    expect(r.error?.kind).toBe('http');
  });

  it('classifyThrown still decides first', async () => {
    const r = await run({
      resolveCredential: resolved,
      probeFn: failingProbe(new McpToolError('x', { kind: 'timeout' })),
      classifyThrown: () => ({ kind: 'custom_kind' }),
    });
    expect(r.error?.kind).toBe('custom_kind');
  });
});

describe('probe path: a status on the cause chain is read', () => {
  it('a hint-wrapper around a 401 is credential_rejected, and reports the status', async () => {
    const inner = Object.assign(new Error('Unauthorized'), { status: 401 });
    const r = await run({
      resolveCredential: resolved,
      probeFn: failingProbe(new McpToolError('Sign in again.', { hint: 'run demo_login', cause: inner })),
    });
    expect(r.error?.kind).toBe('credential_rejected');
    expect(r.probe.status).toBe(401);
  });

  it('an McpToolError carrying status 503 is http', async () => {
    const r = await run({ resolveCredential: resolved, probeFn: failingProbe(new McpToolError('x', { status: 503 })) });
    expect(r.error?.kind).toBe('http');
    expect(r.probe.status).toBe(503);
  });
});

describe('resolver path: a declared kind replaces the no_credential fallback', () => {
  it('a rejected refresh in the resolver is credential_rejected, with copy that names no null source', async () => {
    const r = await run({
      resolveCredential: async () => {
        throw new OAuth2RefreshError(400, 'OAuth2 token refresh failed: 400');
      },
      probeFn: async () => ({}),
    });
    expect(r.credential).toEqual({ source: null, resolved: false });
    expect(r.error?.kind).toBe('credential_rejected');
    expect(r.hint).not.toMatch(/'null'/);
    expect(r.hint).toMatch(/rejected the credential/);
  });

  it('a timeout in the resolver gets copy that does not claim the credential resolved', async () => {
    const r = await run({
      resolveCredential: async () => {
        throw new McpToolError('token mint timed out', { kind: 'timeout' });
      },
      probeFn: async () => ({}),
    });
    expect(r.error?.kind).toBe('timeout');
    expect(r.hint).not.toMatch(/'null'/);
    expect(r.hint).not.toMatch(/resolved/);
  });

  it('an undeclared resolver throw is still no_credential', async () => {
    const r = await run({
      resolveCredential: async () => {
        throw new Error('nope');
      },
      probeFn: async () => ({}),
    });
    expect(r.error?.kind).toBe('no_credential');
  });

  it('classifyThrown still decides first on the resolver path', async () => {
    const r = await run({
      resolveCredential: async () => {
        throw new McpToolError('x', { kind: 'timeout' });
      },
      probeFn: async () => ({}),
      classifyThrown: () => ({ kind: 'bridge_down', hint: 'start the bridge' }),
    });
    expect(r.error?.kind).toBe('bridge_down');
    expect(r.hint).toBe('start the bridge');
  });
});
