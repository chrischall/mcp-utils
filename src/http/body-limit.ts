/**
 * The response-size cap shared by {@link fetchBounded}'s `maxBytes` and
 * `createApiClient`'s `maxBytes` / `maxResponseBytes`.
 *
 * Fleet audit 2026-09 (#733, splitwise-mcp BUG-2, fleet-shared; also #989 /
 * #1026): `createApiClient().fetchRaw` read the body with `res.arrayBuffer()`
 * and no cap, so one very large download (a receipt, a report) was buffered
 * whole — then base64-encoded at 1.33x — in the stdio server. `fetchBounded`
 * already had the cap; this is that one implementation, hoisted so the two
 * transports cannot drift.
 *
 * Internal module: `ResponseTooLargeError` is public (re-exported from
 * `fetch-bounded.ts`); {@link readBytesCapped} is not.
 */

import { McpToolError } from '../errors/index.js';

/**
 * Thrown when a response body is larger than the caller's cap —
 * {@link fetchBounded}'s `maxBytes`, or `createApiClient`'s per-request
 * `maxBytes` / client-wide `maxResponseBytes`. Names the service and the
 * limit, never any of the body. `kind` is `'too_large'`.
 */
export class ResponseTooLargeError extends McpToolError {
  readonly maxBytes: number;
  constructor(service: string, maxBytes: number) {
    super(`Response from ${service} is larger than the ${maxBytes}-byte limit.`, {
      hint: 'Raise maxBytes (or the client\'s maxResponseBytes) if a response this large is expected.',
      kind: 'too_large',
    });
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/**
 * Read `res`'s body, refusing more than `maxBytes` (`undefined` = no cap).
 * A `Content-Length` over the cap is refused before any read; otherwise the
 * stream is read with a running count and cancelled the moment it passes the
 * cap. Every read is passed through `bounded` (the caller's timeout /
 * cancellation race). On ANY failure — the cap, the timer, the caller — the
 * stream is cancelled so its connection is released rather than held until GC.
 */
export async function readBytesCapped(
  res: Response,
  maxBytes: number | undefined,
  service: string,
  bounded: <T>(p: Promise<T>) => Promise<T>,
): Promise<Uint8Array> {
  if (maxBytes !== undefined) {
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      cancelStream(res.body);
      throw new ResponseTooLargeError(service, maxBytes);
    }
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      total += value.byteLength;
      if (maxBytes !== undefined && total > maxBytes) throw new ResponseTooLargeError(service, maxBytes);
      chunks.push(value);
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Release a body unread. Never throws: a custom body may be odd. */
export function cancelStream(body: ReadableStream<Uint8Array> | null): void {
  try {
    body?.cancel().catch(() => {});
  } catch {
    // Nothing left to release.
  }
}
