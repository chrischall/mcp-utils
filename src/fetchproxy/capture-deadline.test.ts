import { describe, it, expect, vi } from 'vitest';
import {
  createFetchproxyTransport,
  deadlineForCaptureWindow,
  CAPTURE_DEADLINE_MARGIN_MS,
} from './index.js';

/**
 * A waiting verb's `timeoutMs` is forwarded to the extension, but its reply is
 * ALSO raced against the transport's `fetchTimeoutMs` (default 30 s), and a
 * per-call value cannot raise that — so the shorter wins, silently.
 *
 * Four callers got this wrong independently. `onehome-mcp` asks for 120 s, and
 * its own comment calls it "the 120s user-interaction timeout"; it gets 30.
 * `alltrails-mcp` and `remind-mcp` name no window and lose the tie, so the
 * extension's rejection — the one carrying the remedy — never arrives. Only
 * `resy-mcp` works around it, and the `fpx` CLI shipped the same bug. That is
 * why the fix is one option here rather than a note in four READMEs.
 */
describe('deadlineForCaptureWindow', () => {
  it('clears a window larger than the default deadline', () => {
    expect(deadlineForCaptureWindow(undefined, 120_000))
      .toBe(120_000 + CAPTURE_DEADLINE_MARGIN_MS);
  });

  /**
   * The margin decides WHICH error the caller sees, so it must leave the
   * extension's timer strictly first — equal is not enough, since the
   * transport's timer starts earlier (its frame has yet to travel).
   */
  it('leaves the extension’s timer strictly first', () => {
    for (const w of [1_000, 30_000, 120_000, 600_000]) {
      expect(deadlineForCaptureWindow(undefined, w)!).toBeGreaterThan(w);
      expect(deadlineForCaptureWindow(30_000, w)!).toBeGreaterThan(w);
    }
  });

  /**
   * ONE-DIRECTIONAL. A caller who set a short deadline and declares a window
   * that already fits inside it keeps their bound — otherwise this turns from
   * "stop capping the caller" into "ignore the caller".
   */
  it('never shortens a deadline', () => {
    expect(deadlineForCaptureWindow(300_000, 1_000)).toBe(300_000);
    expect(deadlineForCaptureWindow(60_000, 5_000)).toBe(60_000);
  });

  it('leaves an explicitly unbounded transport unbounded', () => {
    expect(deadlineForCaptureWindow(0, 120_000)).toBe(0);
  });

  it('is a no-op when no window is declared — every existing consumer', () => {
    expect(deadlineForCaptureWindow(30_000, undefined)).toBe(30_000);
    expect(deadlineForCaptureWindow(undefined, undefined)).toBeUndefined();
    expect(deadlineForCaptureWindow(undefined, 0)).toBeUndefined();
  });
});

describe('createFetchproxyTransport — the window reaches the server', () => {
  const construct = () => {
    const seen: Record<string, unknown>[] = [];
    const createServer = vi.fn((o: Record<string, unknown>) => {
      seen.push(o);
      return { role: null, listen: async () => {}, close: async () => {} } as never;
    });
    return { seen, createServer };
  };

  it('raises fetchTimeoutMs to clear a declared window', () => {
    const { seen, createServer } = construct();
    createFetchproxyTransport({
      serverName: 'x-mcp', version: '1.0.0', domains: ['x.com'],
      captureWindowMs: 120_000,
      createServer: createServer as never,
    });
    expect(seen[0]!.fetchTimeoutMs).toBe(120_000 + CAPTURE_DEADLINE_MARGIN_MS);
  });

  // The option is ours, not the server's — forwarding it would reach a
  // FetchproxyServerOpts that has no such field.
  it('does not forward captureWindowMs to the server', () => {
    const { seen, createServer } = construct();
    createFetchproxyTransport({
      serverName: 'x-mcp', version: '1.0.0', domains: ['x.com'],
      captureWindowMs: 120_000,
      createServer: createServer as never,
    });
    expect(seen[0]!).not.toHaveProperty('captureWindowMs');
  });

  it('changes nothing for a consumer that declares no window', () => {
    const { seen, createServer } = construct();
    createFetchproxyTransport({
      serverName: 'x-mcp', version: '1.0.0', domains: ['x.com'],
      createServer: createServer as never,
    });
    expect(seen[0]!).not.toHaveProperty('fetchTimeoutMs');
  });
});
