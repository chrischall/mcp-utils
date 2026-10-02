import { describe, it, expect } from 'vitest';
import { isTimeoutError } from './index.js';
import { RequestTimeoutError } from '../http/index.js';

/** Shaped exactly like onehome-mcp's src/request-deadline.ts error (fleet-audit#1078). */
class OneHomeRequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'OneHomeRequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

describe('isTimeoutError', () => {
  it('recognises a consumer-defined *TimeoutError by name (onehome shape)', () => {
    expect(isTimeoutError(new OneHomeRequestTimeoutError('OneHome GraphQL', 25_000))).toBe(true);
  });

  it("recognises mcp-utils' own RequestTimeoutError", () => {
    expect(isTimeoutError(new RequestTimeoutError('svc', 10))).toBe(true);
  });

  it("recognises AbortSignal.timeout()'s DOMException reason", async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(signal.aborted).toBe(true);
    expect(isTimeoutError(signal.reason)).toBe(true);
  });

  it('recognises the documented `timedOut: true` marker on any error', () => {
    const err = Object.assign(new Error('upstream stalled'), { timedOut: true });
    expect(isTimeoutError(err)).toBe(true);
  });

  it('recognises socket-level timeout codes', () => {
    expect(isTimeoutError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isTimeoutError(Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe(true);
    expect(isTimeoutError(Object.assign(new Error('x'), { code: 'UND_ERR_BODY_TIMEOUT' }))).toBe(true);
    expect(isTimeoutError(Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))).toBe(true);
    expect(isTimeoutError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(false);
  });

  it("walks undici's TypeError('fetch failed', { cause }) wrapper", () => {
    const cause = Object.assign(new Error('connect'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(isTimeoutError(new TypeError('fetch failed', { cause }))).toBe(true);
  });

  it('does NOT classify a caller cancellation (AbortError) as a timeout', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isTimeoutError(controller.signal.reason)).toBe(false);
    expect(isTimeoutError(new DOMException('cancelled', 'AbortError'))).toBe(false);
    // Cancellation wins even if something in the chain looks like a timeout.
    const abort = new DOMException('cancelled', 'AbortError');
    Object.defineProperty(abort, 'cause', { value: new RequestTimeoutError('svc', 1) });
    expect(isTimeoutError(abort)).toBe(false);
    // ...and a wrapper around a cancellation is still not a timeout.
    expect(isTimeoutError(new Error('wrapped', { cause: new DOMException('c', 'AbortError') }))).toBe(false);
  });

  it('honours an explicit `timedOut: false` (e.g. GraphqlTransportError on a network failure)', () => {
    const err = Object.assign(new Error('x'), { name: 'GraphqlTransportError', timedOut: false, code: 'ETIMEDOUT' });
    expect(isTimeoutError(err)).toBe(false);
  });

  it('is false for ordinary errors, non-errors, and errors that merely mention a timeout', () => {
    expect(isTimeoutError(new Error('listing not found within group'))).toBe(false);
    expect(isTimeoutError(new Error('request timed out'))).toBe(false);
    expect(isTimeoutError('TimeoutError')).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
    expect(isTimeoutError({ name: 'Timeout' })).toBe(false);
  });

  it('accepts a plain object that declares itself a timeout (duck-typed, no instanceof)', () => {
    expect(isTimeoutError({ name: 'TimeoutError', message: 'x' })).toBe(true);
  });

  it("a timeout class wrapping its own timer's AbortError is still a timeout (outermost declaration wins)", () => {
    const err = new OneHomeRequestTimeoutError('x', 1) as Error & { cause?: unknown };
    err.cause = new DOMException('aborted', 'AbortError');
    expect(isTimeoutError(err)).toBe(true);
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(isTimeoutError(a)).toBe(false);
  });
});
