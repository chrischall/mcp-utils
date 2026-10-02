import { describe, it, expect, vi } from 'vitest';
import { FetchproxyTimeoutError, retryOnceOnTimeout, classifyRowError } from './index.js';
import { RequestTimeoutError } from '../http/index.js';

// fleet-audit#1078: onehome-mcp's direct-fetch deadline throws its own error
// class, not a FetchproxyTimeoutError; bulk rows must still retry once and
// classify as 'timeout' rather than 'other'.
class OneHomeRequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'OneHomeRequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

describe('retryOnceOnTimeout (mcp-utils wrapper)', () => {
  it('retries a consumer-defined timeout error once', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new OneHomeRequestTimeoutError('OneHome GraphQL ListingById', 25_000))
      .mockResolvedValueOnce('ok');
    await expect(retryOnceOnTimeout(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries only once — a second timeout propagates', async () => {
    const err = new RequestTimeoutError('svc', 5);
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(err);
    await expect(retryOnceOnTimeout(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a caller cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(controller.signal.reason);
    await expect(retryOnceOnTimeout(fn)).rejects.toBe(controller.signal.reason);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a timeout that declares retrySafe: false', async () => {
    const err = Object.assign(new OneHomeRequestTimeoutError('write', 1), { retrySafe: false });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(err);
    await expect(retryOnceOnTimeout(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry an ordinary error', async () => {
    const err = new Error('listing not found within group');
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(err);
    await expect(retryOnceOnTimeout(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still retries a bridge FetchproxyTimeoutError (unchanged behaviour)', async () => {
    const err = new FetchproxyTimeoutError({ url: 'https://x.test/', timeoutMs: 10, elapsedMs: 11, role: 'host', port: 1 });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(err).mockResolvedValueOnce('ok');
    await expect(retryOnceOnTimeout(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('retryOnceOnTimeout — bridge retrySafe gate', () => {
  it('does not re-send a bridge timeout marked retrySafe: false (a timed-out write)', async () => {
    const err = new FetchproxyTimeoutError({ url: 'https://x.test/', timeoutMs: 10, elapsedMs: 11, role: 'host', port: 1, retrySafe: false });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(err);
    await expect(retryOnceOnTimeout(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('classifyRowError (mcp-utils wrapper)', () => {
  it("classifies a consumer-defined timeout as 'timeout', distinct from 'other'", () => {
    const res = classifyRowError(new OneHomeRequestTimeoutError('OneHome GraphQL ListingById', 25_000));
    expect(res.kind).toBe('timeout');
    expect(res.message).toBe('timeout after retry: OneHome GraphQL ListingById timed out after 25000ms');
  });

  it("says 'not retried' for a retrySafe: false timeout", () => {
    const err = Object.assign(new RequestTimeoutError('svc', 5), { retrySafe: false });
    const res = classifyRowError(err);
    expect(res.kind).toBe('timeout');
    expect(res.message).toMatch(/^timeout \(not retried\): /);
  });

  it("classifies a caller cancellation as 'other', not 'timeout'", () => {
    const res = classifyRowError(new DOMException('The operation was aborted.', 'AbortError'));
    expect(res.kind).toBe('other');
  });

  it("keeps fetchproxy's own wording for a bridge timeout", () => {
    const res = classifyRowError(new FetchproxyTimeoutError({ url: 'https://x.test/', timeoutMs: 10, elapsedMs: 11, role: 'host', port: 1 }));
    expect(res.kind).toBe('timeout');
    expect(res.message).toMatch(/^bridge timeout after retry: /);
  });

  it("leaves a genuine miss as 'other'", () => {
    expect(classifyRowError(new Error('listing not found within group'))).toEqual({
      kind: 'other',
      message: 'listing not found within group',
    });
  });
});
