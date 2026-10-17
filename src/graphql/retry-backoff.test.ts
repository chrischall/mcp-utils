/**
 * fleet-audit#1261 / #1223: hemnet-mcp's and booli-mcp's `transport-direct.ts`
 * could not move onto createGraphqlClient without regressing — it threw on the
 * first network error, waited a fixed delay, let Retry-After REPLACE the
 * backoff instead of flooring it (fleet-audit#495), and threw a generic
 * EdgeBlockedError without the diagnostics their healthchecks classify on.
 * These are hemnet's tests/transport-direct.test.ts cases, against the shared
 * client configured the way hemnet would configure it.
 */
import { describe, expect, it, vi } from 'vitest';
import { EdgeBlockedError } from '../http/index.js';
import {
  GraphqlTransportError,
  createGraphqlClient,
  responseDiagnostics,
  type GraphqlClientOptions,
  type GraphqlRetryPolicy,
} from './index.js';

const ENDPOINT = 'https://www.example.se/graphql';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) } as unknown as Response;
}

function textResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => body } as unknown as Response;
}

class ChallengeError extends EdgeBlockedError {
  constructor(message: string, status: number, vendor: string) {
    super(status, vendor, { service: 'Hemnet', method: 'POST', path: '/graphql' });
    this.name = 'ChallengeError';
    this.message = message;
  }
}

/** The retry policy hemnet's DirectTransport implements. */
const HEMNET_RETRY: GraphqlRetryPolicy = {
  count: 2,
  delayMs: 1000,
  statuses: [429, 500, 502, 503, 504],
  honorRetryAfter: true,
  maxRetryAfterMs: 10_000,
  retryAfterAsFloor: true,
  backoff: 'exponential',
  jitter: 0.5,
  transportErrors: true,
};

function hemnet(fetchImpl: unknown, extra: Partial<GraphqlClientOptions> = {}) {
  return createGraphqlClient({
    endpoint: ENDPOINT,
    serviceName: 'Hemnet',
    fetchImpl: fetchImpl as typeof fetch,
    sleep: async () => {},
    random: () => 0,
    retry: HEMNET_RETRY,
    onEdgeBlocked: ({ status, vendor, headers }) => {
      const diag = responseDiagnostics(headers);
      return new ChallengeError(`Hemnet GraphQL HTTP ${status} — ${vendor} bot challenge${diag ? ` (${diag})` : ''}. Use a browser.`, status, vendor);
    },
    onErrorResponse: ({ status, headers, body }) => {
      const diag = responseDiagnostics(headers);
      if (status < 400) return new Error(`Hemnet GraphQL HTTP ${status} returned non-JSON — body starts: ${body.slice(0, 200)}`);
      return new Error(`Hemnet GraphQL HTTP ${status}${diag ? ` (${diag})` : ''}${body ? ` — body starts: ${body.slice(0, 200)}` : ''}`);
    },
    ...extra,
  });
}

function recorder() {
  const waits: number[] = [];
  return { waits, sleep: vi.fn(async (ms: number) => void waits.push(ms)) };
}

describe('transport-error retry (retry.transportErrors)', () => {
  it('retries a network error, then succeeds', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(jsonResponse(200, { data: { ok: 1 } }));
    await expect(hemnet(fetchImpl).request('query Q { ok }')).resolves.toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws the transport error after exhausting the budget', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const err = await hemnet(fetchImpl, { retry: { ...HEMNET_RETRY, count: 1 } }).request('query Q { ok }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphqlTransportError);
    expect((err as Error).message).toContain('ECONNRESET');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a timeout too', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce(jsonResponse(200, { data: { ok: 1 } }));
      const p = hemnet(fetchImpl, { timeout: 50, sleep: async () => {} }).request('query Q { ok }');
      await vi.advanceTimersByTimeAsync(60);
      await expect(p).resolves.toEqual({ ok: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never retries a MUTATION after a transport error — it may have committed', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const err = await hemnet(fetchImpl).request('mutation M { save }').catch((e: unknown) => e);
    expect((err as GraphqlTransportError).outcomeUnknown).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('is off by default: a network error throws at once', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(hemnet(fetchImpl, { retry: { count: 2, delayMs: 1 } }).request('query Q { ok }')).rejects.toBeInstanceOf(GraphqlTransportError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('never retries a caller cancellation', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn(async () => {
      throw abort;
    });
    await expect(hemnet(fetchImpl).request('query Q { ok }')).rejects.toBe(abort);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('backoff (fleet-audit#495)', () => {
  it('honours a 429 Retry-After (delta-seconds) before retrying', async () => {
    const { waits, sleep } = recorder();
    const fetchImpl = vi.fn().mockResolvedValueOnce(textResponse(429, 'slow down', { 'retry-after': '7' })).mockResolvedValueOnce(jsonResponse(200, { data: { ok: 1 } }));
    await expect(hemnet(fetchImpl, { sleep }).request('query Q { ok }')).resolves.toEqual({ ok: 1 });
    expect(waits).toEqual([7000]);
  });

  it('caps an excessive Retry-After at maxRetryAfterMs', async () => {
    const { waits, sleep } = recorder();
    const fetchImpl = vi.fn().mockResolvedValueOnce(textResponse(429, '', { 'retry-after': '3600' })).mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    await hemnet(fetchImpl, { sleep, retry: { ...HEMNET_RETRY, maxRetryAfterMs: 5000 } }).execute({ query: 'query Q { ok }' });
    expect(waits).toEqual([5000]);
  });

  it('backs off exponentially with jitter (>=1s, >=2s) when no Retry-After is sent', async () => {
    const lo = recorder();
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    await expect(hemnet(fetchImpl, { sleep: lo.sleep }).request('query Q { ok }')).rejects.toThrow('HTTP 503');
    expect(lo.waits).toEqual([1000, 2000]);

    const hi = recorder();
    await expect(hemnet(fetchImpl, { sleep: hi.sleep, random: () => 0.999 }).request('query Q { ok }')).rejects.toThrow('HTTP 503');
    expect(hi.waits[0]).toBeGreaterThan(1400);
    expect(hi.waits[0]).toBeLessThan(1500);
    expect(hi.waits[1]).toBeGreaterThan(2900);
    expect(hi.waits[1]).toBeLessThan(3000);
  });

  it('never waits less than the jittered backoff when Retry-After is shorter (the floor)', async () => {
    const { waits, sleep } = recorder();
    const fetchImpl = vi.fn().mockResolvedValueOnce(textResponse(429, '', { 'retry-after': '0' })).mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    await hemnet(fetchImpl, { sleep }).execute({ query: 'query Q { ok }' });
    expect(waits).toEqual([1000]);
  });

  it('does not carry a Retry-After over to a later network-error retry', async () => {
    const { waits, sleep } = recorder();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(429, '', { 'retry-after': '9' }))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    await hemnet(fetchImpl, { sleep }).execute({ query: 'query Q { ok }' });
    expect(waits).toEqual([9000, 2000]);
  });

  it('a fixed exponential schedule with no jitter and no Retry-After (booli: 500 ms, 1 s)', async () => {
    const { waits, sleep } = recorder();
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    await hemnet(fetchImpl, {
      sleep,
      retry: { count: 2, delayMs: 500, statuses: [429, 500, 502, 503, 504], backoff: 'exponential', transportErrors: true },
    })
      .request('query Q { ok }')
      .catch(() => undefined);
    expect(waits).toEqual([500, 1000]);
  });

  it('keeps the historical behaviour when none of the new fields is set: Retry-After REPLACES the fixed delay', async () => {
    const { waits, sleep } = recorder();
    const fetchImpl = vi.fn().mockResolvedValueOnce(textResponse(429, '', { 'retry-after': '0' })).mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    await createGraphqlClient({ endpoint: ENDPOINT, fetchImpl: fetchImpl as unknown as typeof fetch, sleep, retry: { count: 1, delayMs: 2000, honorRetryAfter: true } }).execute({
      query: 'query Q { ok }',
    });
    expect(waits).toEqual([0]);
  });

  it('waits on a real timer by default', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(503, {})).mockResolvedValueOnce(jsonResponse(200, { data: { ok: 1 } }));
      const pending = hemnet(fetchImpl, { sleep: undefined }).request('query Q { ok }');
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchImpl).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ ok: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('edge blocks: checked before any retry, with a hook for the error', () => {
  it('a Cloudflare challenge 403 becomes the hook\'s error with the cf-ray diagnostics, unretried', async () => {
    const fetchImpl = vi.fn(async () =>
      textResponse(403, '<!DOCTYPE html><html><head><title>Just a moment...</title>', {
        'cf-mitigated': 'challenge',
        'cf-ray': 'a1a7d3f27ca34ff4-ATL',
        server: 'cloudflare',
      }),
    );
    const err = await hemnet(fetchImpl).request('query Q { ok }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChallengeError);
    expect(err).toBeInstanceOf(EdgeBlockedError);
    const msg = (err as Error).message;
    expect(msg).toContain('HTTP 403');
    expect(msg).toContain('Cloudflare');
    expect(msg).toContain('server: cloudflare; cf-ray: a1a7d3f27ca34ff4-ATL; cf-mitigated: challenge');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('a challenge by body marker with no diagnostic headers', async () => {
    const fetchImpl = vi.fn(async () => textResponse(403, '<html><script>window._cf_chl_opt = {};</script></html>'));
    const err = await hemnet(fetchImpl).request('query Q { ok }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChallengeError);
    expect((err as Error).message).toContain('Cloudflare bot challenge.');
  });

  it('a challenge served as 429 is NOT retried (fleet-audit#1019)', async () => {
    const fetchImpl = vi.fn(async () => textResponse(429, 'rate limited', { 'cf-mitigated': 'challenge' }));
    const err = await hemnet(fetchImpl).request('query Q { ok }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChallengeError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('the legacy JS challenge served as 503 is NOT retried', async () => {
    const fetchImpl = vi.fn(async () => textResponse(503, '<html><script>window._cf_chl_opt = {};</script></html>'));
    const err = await hemnet(fetchImpl).request('query Q { ok }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChallengeError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('a challenge page served as a 2xx goes through the hook too', async () => {
    const fetchImpl = vi.fn(async () => textResponse(200, '<!DOCTYPE html><title>Just a moment...</title>'));
    const err = await hemnet(fetchImpl).request('query Q { ok }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChallengeError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('without the hook, still the plain EdgeBlockedError', async () => {
    const fetchImpl = vi.fn(async () => textResponse(403, '<title>Just a moment...</title>', { 'cf-mitigated': 'challenge' }));
    const err = await hemnet(fetchImpl, { onEdgeBlocked: undefined }).request('query Q { ok }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdgeBlockedError);
    expect(err).not.toBeInstanceOf(ChallengeError);
    expect((err as EdgeBlockedError).vendor).toBe('Cloudflare');
  });
});

describe('onErrorResponse', () => {
  it('maps a hard 4xx with the body head and diagnostics, unretried', async () => {
    const body = `{"error":"nope"}${'x'.repeat(300)}`;
    const fetchImpl = vi.fn(async () => textResponse(403, body, { server: 'nginx', 'cf-ray': 'abc123-CPH' }));
    const err = await hemnet(fetchImpl).request('query Q { ok }').catch((e: unknown) => e);
    const msg = (err as Error).message;
    expect(msg).toContain('Hemnet GraphQL HTTP 403');
    expect(msg).toContain('server: nginx; cf-ray: abc123-CPH');
    expect(msg).toContain('{"error":"nope"}');
    expect(msg.length).toBeLessThan(500);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('sees a JSON 4xx envelope too, through execute() — the raw passthrough path', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, {}));
    await expect(hemnet(fetchImpl).execute({ query: 'query Q { ok }' })).rejects.toThrow('HTTP 400');
  });

  it('maps an exhausted retryable status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    await expect(hemnet(fetchImpl).request('query Q { ok }')).rejects.toThrow('Hemnet GraphQL HTTP 503');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('maps a non-JSON, non-challenge 2xx with the body head, unretried', async () => {
    const fetchImpl = vi.fn(async () => textResponse(200, '<html>maintenance</html>'));
    const err = await hemnet(fetchImpl).request('query Q { ok }').catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/non-JSON.*maintenance/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('an error body that cannot be read is an empty body, not a transport failure', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => {
        throw new Error('body stream lost');
      },
    }));
    await expect(hemnet(fetchImpl).request('query Q { ok }')).rejects.toThrow(/^Hemnet GraphQL HTTP 400$/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('falls through to the default when it returns undefined', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { errors: [{ message: 'bad field' }] }));
    await expect(hemnet(fetchImpl, { onErrorResponse: () => undefined }).request('query Q { ok }')).rejects.toThrow('Hemnet GraphQL error: bad field');
  });

  it('is not consulted for a GraphQL answer at 2xx (errors[] is request()\'s business)', async () => {
    const hook = vi.fn(() => new Error('no'));
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: { ok: 1 } }));
    await expect(hemnet(fetchImpl, { onErrorResponse: hook }).execute({ query: 'query Q { ok }' })).resolves.toMatchObject({ data: { ok: 1 } });
    expect(hook).not.toHaveBeenCalled();
  });

  it('runs after an auth replay, not instead of it', async () => {
    const onAuthError = vi.fn(async () => {});
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, {})).mockResolvedValueOnce(jsonResponse(200, { data: { ok: 1 } }));
    await expect(hemnet(fetchImpl, { onAuthError }).request('query Q { ok }')).resolves.toEqual({ ok: 1 });
    expect(onAuthError).toHaveBeenCalledOnce();
  });

  it('returns the raw envelope for a GraphQL answer — the shape hemnet hands its client', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: null, errors: [{ message: 'not found' }] }));
    const res = await hemnet(fetchImpl).execute({ query: 'query Q { ok }', variables: { a: 1 } });
    expect(res.data).toBeNull();
    expect(res.errors).toEqual([{ message: 'not found' }]);
  });
});

describe('responseDiagnostics', () => {
  it('lists the present server / cf-ray / cf-mitigated headers, in that order', () => {
    expect(responseDiagnostics(new Headers({ 'cf-ray': 'r', server: 's' }))).toBe('server: s; cf-ray: r');
    expect(responseDiagnostics(new Headers())).toBe('');
  });

  it('takes other header names', () => {
    expect(responseDiagnostics(new Headers({ 'x-amz-cf-id': 'abc' }), ['x-amz-cf-id'])).toBe('x-amz-cf-id: abc');
  });

  it('caps each value, so a hostile header cannot flood a message', () => {
    expect(responseDiagnostics(new Headers({ server: 'x'.repeat(1000) })).length).toBeLessThan(150);
  });
});
