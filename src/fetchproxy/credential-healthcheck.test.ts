import { describe, expect, it } from 'vitest';

import { registerCredentialHealthcheckTool } from './index.js';
import { createTestHarness, parseToolResult } from '../test/index.js';

interface Result {
  ok: boolean;
  credential: { source: string | null; resolved: boolean; detail?: Record<string, unknown> };
  probe: { url?: string; elapsed_ms: number; status?: number };
  error?: { kind: string; message: string; detail?: Record<string, unknown> };
  hint: string;
}

async function run(args: Parameters<typeof registerCredentialHealthcheckTool>[0]) {
  const h = await createTestHarness((server) =>
    registerCredentialHealthcheckTool({ ...args, server }),
  );
  const res = await h.client.callTool({ name: 'demo_healthcheck', arguments: {} });
  await h.close?.();
  return parseToolResult<Result>(res as never);
}

const base = {
  prefix: 'demo',
  hostLabel: 'api.demo.com',
  probePath: '/v1/me',
} as const;

describe('registerCredentialHealthcheckTool', () => {
  it('reports ok when the credential resolves and the probe succeeds', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env', detail: { age_days: 3 } }),
      probeFn: async () => ({ id: 1 }),
    });
    expect(r.ok).toBe(true);
    expect(r.credential).toMatchObject({ source: 'env', resolved: true, detail: { age_days: 3 } });
    expect(r.probe.url).toBe('https://api.demo.com/v1/me');
    expect(r.error).toBeUndefined();
  });

  // The whole reason this helper exists: "no credential" and "credential
  // rejected" are different problems with different fixes, and today they both
  // surface as one opaque error.
  it('distinguishes no_credential from a rejected one', async () => {
    const none = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: null }),
      probeFn: async () => {
        throw new Error('should not be probed');
      },
    });
    expect(none.ok).toBe(false);
    expect(none.error?.kind).toBe('no_credential');
    expect(none.credential.resolved).toBe(false);
    expect(none.hint).toMatch(/sign in|credential|token/i);
  });

  it('does not probe at all when no credential resolved', async () => {
    let probed = false;
    await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: null }),
      probeFn: async () => {
        probed = true;
        return {};
      },
    });
    expect(probed).toBe(false);
  });

  it('classifies a 401 as credential_rejected, not a generic http error', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'fetchproxy' }),
      probeFn: async () => {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
    });
    expect(r.error?.kind).toBe('credential_rejected');
    expect(r.credential.source).toBe('fetchproxy');
  });

  it('keeps a non-auth http status as http', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw Object.assign(new Error('Server error'), { status: 503 });
      },
    });
    expect(r.error?.kind).toBe('http');
  });

  it('lets a consumer re-kind a thrown error and supply copy', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new Error('district not selected');
      },
      classifyThrown: (e) =>
        (e as Error).message.includes('district')
          ? { kind: 'needs_district', hint: 'Pick a district first.', detail: { field: 'IC_DISTRICT' } }
          : undefined,
    });
    expect(r.error?.kind).toBe('needs_district');
    expect(r.error?.detail).toEqual({ field: 'IC_DISTRICT' });
    expect(r.hint).toBe('Pick a district first.');
  });

  it('reports a resolver that itself throws rather than crashing the tool', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => {
        throw new Error('bridge minted nothing');
      },
      probeFn: async () => ({}),
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('no_credential');
    expect(r.error?.message).toMatch(/bridge minted nothing/);
  });

  it('measures elapsed time even on failure', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new Error('nope');
      },
    });
    expect(typeof r.probe.elapsed_ms).toBe('number');
  });

  it('omits the probe URL when no probePath was configured', async () => {
    const r = await run({
      prefix: 'demo',
      hostLabel: 'api.demo.com',
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => ({}),
    });
    expect(r.probe.url).toBeUndefined();
    expect(r.ok).toBe(true);
  });
});
