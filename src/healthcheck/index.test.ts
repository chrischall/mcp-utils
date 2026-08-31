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

  it("classifies a bare AbortController abort as timeout, by err.name", async () => {
    // The message carries nothing useful for a bare abort — matching text
    // alone classified these as 'unknown'. src/http/index.ts checks err.name.
    const abort = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw abort;
      },
    });
    expect(r.error?.kind).toBe('timeout');
  });

  it("classifies a message-shaped timeout as timeout", async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new Error('ETIMEDOUT connecting to host');
      },
    });
    expect(r.error?.kind).toBe('timeout');
  });

  it('classifies an unreachable host as transport', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new Error('fetch failed');
      },
    });
    expect(r.error?.kind).toBe('transport');
    expect(r.hint).toMatch(/reach/i);
  });

  it('honours a per-arm hints override', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: null }),
      probeFn: async () => ({}),
      hints: { no_credential: 'Connect the connector first.' },
    });
    expect(r.hint).toBe('Connect the connector first.');
  });

  // A healthcheck is the tool people paste into a chat when something is
  // broken, and upstream failures routinely quote what they were sent.
  it('redacts secrets out of an upstream error message', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new Error('rejected: Bearer sk-live-ABCDEF1234567890abcdef');
      },
    });
    expect(r.error?.message ?? '').not.toContain('sk-live-ABCDEF1234567890abcdef');
  });

  it('redacts a secret thrown by the resolver too', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => {
        throw new Error('mint failed for Bearer sk-live-ABCDEF1234567890abcdef');
      },
      probeFn: async () => ({}),
    });
    expect(r.error?.message ?? '').not.toContain('sk-live-ABCDEF1234567890abcdef');
  });

  // Resolving can mint a token or drive the browser bridge; counting that as
  // probe latency reports it as far-side slowness.
  it('excludes credential-resolution time from probe.elapsed_ms', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => {
        await new Promise((res) => setTimeout(res, 60));
        return { source: 'env' };
      },
      probeFn: async () => ({}),
    });
    expect(r.probe.elapsed_ms).toBeLessThan(50);
  });

  it('emits no probe.url on the no-credential paths', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: null }),
      probeFn: async () => ({}),
    });
    expect(r.probe.url).toBeUndefined();
  });
});

// A `resolveCredential` that THROWS used to be flattened into `no_credential`
// with that arm's static hint, whatever the cause. So "nothing is configured"
// and "the browser bridge is down" — or a password the upstream rejected —
// came out identical, and the one hint on offer told people to set variables
// that were already set. Consumers could classify a PROBE failure and not this.
describe('a resolver throw can be classified', () => {
  const base = {
    prefix: 'demo',
    hostLabel: 'example.com',
    probeFn: async () => ({ ok: true }),
  };

  it('uses classifyThrown for a resolver failure that is not a missing credential', async () => {
    const r = await run({
      ...base,
      resolveCredential: async () => {
        throw new Error('bridge is down');
      },
      classifyThrown: (err) =>
        String((err as Error).message).includes('bridge')
          ? { kind: 'transport', hint: 'The bridge is down — start the extension.', detail: { hop: 'bridge' } }
          : undefined,
    } as never);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('transport');
    expect(r.error?.detail).toEqual({ hop: 'bridge' });
    expect(r.hint).toBe('The bridge is down — start the extension.');
    // Still true: nothing resolved. The classification explains WHY, it does
    // not invent a credential.
    expect(r.credential.resolved).toBe(false);
    expect(r.credential.source).toBeNull();
    // Nothing was probed, so no url may be implied.
    expect(r.probe.url).toBeUndefined();
  });

  it('falls back to no_credential when classifyThrown declines', async () => {
    const r = await run({
      ...base,
      resolveCredential: async () => {
        throw new Error('nothing configured');
      },
      classifyThrown: () => undefined,
    } as never);
    expect(r.error?.kind).toBe('no_credential');
    expect(r.error?.message).toMatch(/nothing configured/);
  });

  // Backwards compatibility: every consumer written before this passes no
  // classifier at all, and must behave exactly as it did.
  it('is unchanged when no classifier is supplied', async () => {
    const r = await run({
      ...base,
      resolveCredential: async () => {
        throw new Error('boom');
      },
    } as never);
    expect(r.error?.kind).toBe('no_credential');
    expect(r.hint).toMatch(/No credential resolved/i);
  });

  it('still prefers an explicit hints override for the fallback arm', async () => {
    const r = await run({
      ...base,
      resolveCredential: async () => {
        throw new Error('boom');
      },
      hints: { no_credential: 'custom copy' },
    } as never);
    expect(r.hint).toBe('custom copy');
  });
});

// A classifier may name a kind without supplying copy. The hint then has to
// follow THAT kind — falling back to `no_credential`'s copy would state a
// cause the `kind` beside it contradicts, which is the whole failure this
// classification path exists to remove.
describe('a classified resolver throw gets a hint matching its kind', () => {
  const base = {
    prefix: 'demo',
    hostLabel: 'example.com',
    probeFn: async () => ({ ok: true }),
    resolveCredential: async () => {
      throw new Error('bridge is down');
    },
  };

  it('uses the classified arm’s default copy when the classifier gives no hint', async () => {
    const r = await run({ ...base, classifyThrown: () => ({ kind: 'transport' }) } as never);
    expect(r.error?.kind).toBe('transport');
    expect(r.hint).not.toMatch(/No credential resolved/i);
    // transport's own copy, not no_credential's
    expect(r.hint).toMatch(/example\.com/);
  });

  it('prefers a hints override for the CLASSIFIED arm, not for no_credential', async () => {
    const r = await run({
      ...base,
      classifyThrown: () => ({ kind: 'transport' }),
      hints: { transport: 'transport copy', no_credential: 'WRONG' },
    } as never);
    expect(r.hint).toBe('transport copy');
  });

  // A consumer may use a kind of its own (kia_healthcheck reports
  // `no_session`). There is no copy for it, and no_credential's would assert a
  // cause that kind denies — so the neutral `unknown` copy is the honest one.
  it('does not assert a cause for a custom kind it has no copy for', async () => {
    const r = await run({ ...base, classifyThrown: () => ({ kind: 'no_session' }) } as never);
    expect(r.error?.kind).toBe('no_session');
    expect(r.hint).not.toMatch(/No credential resolved/i);
  });

  it('an inline hint still wins over everything', async () => {
    const r = await run({
      ...base,
      classifyThrown: () => ({ kind: 'transport', hint: 'inline' }),
      hints: { transport: 'override' },
    } as never);
    expect(r.hint).toBe('inline');
  });
});
