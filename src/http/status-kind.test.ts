/**
 * The http module's throwers declare a structured `kind` (and keep `status`),
 * so a consumer — and the credential healthcheck — classifies them without
 * regex over the message (fleet audit 2026-09, cluster 8).
 */
import { describe, it, expect } from 'vitest';
import { errorKindOf, errorStatusOf } from '../errors/index.js';
import {
  ApiError,
  EdgeBlockedError,
  RateLimitedError,
  RequestTimeoutError,
  UnauthorizedError,
  UpstreamHttpError,
  WriteOutcomeUnknownError,
  fetchBounded,
} from './index.js';

describe('http error kinds', () => {
  it('UnauthorizedError is a 401 credential_rejected', () => {
    const err = new UnauthorizedError('Svc');
    expect(err.status).toBe(401);
    expect(err.kind).toBe('credential_rejected');
    expect(errorKindOf(err)).toBe('credential_rejected');
  });

  it('RateLimitedError is a 429 http', () => {
    const err = new RateLimitedError('Svc', 1000);
    expect(err.status).toBe(429);
    expect(err.kind).toBe('http');
  });

  it('RequestTimeoutError is a timeout with no status', () => {
    const err = new RequestTimeoutError('Svc', 5000);
    expect(err.kind).toBe('timeout');
    expect(errorStatusOf(err)).toBeUndefined();
  });

  it('EdgeBlockedError is edge_blocked and keeps its status', () => {
    const err = new EdgeBlockedError(403, 'CloudFront', { service: 'Svc' });
    expect(err.status).toBe(403);
    expect(err.kind).toBe('edge_blocked');
    expect(err).toBeInstanceOf(ApiError);
  });

  it('ApiError / UpstreamHttpError keep only the status (the status says which)', () => {
    expect(errorKindOf(new ApiError(404, 'x'))).toBeUndefined();
    expect(errorStatusOf(new UpstreamHttpError(503, 'x'))).toBe(503);
  });

  it('WriteOutcomeUnknownError is timeout when timed out, transport when dropped', () => {
    const timed = new WriteOutcomeUnknownError('Svc', 'post', { timeoutMs: 5000 });
    expect(timed.kind).toBe('timeout');
    expect(timed.status).toBeUndefined();
    const dropped = new WriteOutcomeUnknownError('Svc', 'post', { cause: new TypeError('terminated') });
    expect(dropped.kind).toBe('transport');
  });
});

describe('fetchBounded non-JSON body', () => {
  it('throws an McpToolError carrying the response status', async () => {
    const fetchImpl = (async () =>
      new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const err = await fetchBounded('https://x.test/a', undefined, {
      service: 'Example',
      read: 'json',
      fetchImpl,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(errorStatusOf(err)).toBe(200);
  });
});
