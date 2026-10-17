/**
 * fleet-audit#1306: microsoft-teams-mcp `src/tools/send.ts` and
 * office-outlook-mcp `src/tools/writes.ts` each carry the same adapter that
 * turns a WriteOutcomeUnknownError into a non-error `status: "unknown"`
 * result, so the model checks before re-sending instead of starting over.
 */
import { describe, expect, it } from 'vitest';
import { McpToolError } from '../errors/index.js';
import { RequestTimeoutError, WriteOutcomeUnknownError, unknownOutcomeReason, writeOrUnknown, writeOutcomeStatus } from './index.js';

const timedOut = () => new WriteOutcomeUnknownError('Teams', 'POST', { timeoutMs: 60_000, cause: new RequestTimeoutError('Teams', 60_000) });
const dropped = () => new WriteOutcomeUnknownError('Teams', 'POST', { cause: new TypeError('terminated') });
const answered5xx = () => new WriteOutcomeUnknownError('Teams', 'POST', { cause: Object.assign(new Error('HTTP 502'), { status: 502 }) });

describe('writeOrUnknown', () => {
  it('passes a successful write through', async () => {
    await expect(writeOrUnknown(async () => 42, () => 'unknown')).resolves.toEqual({ ok: true, value: 42 });
  });

  it('turns an unknown outcome into the caller\'s result, never an error', async () => {
    const out = await writeOrUnknown(
      async () => {
        throw timedOut();
      },
      (err, why) => ({ status: 'unknown', why, method: err.method }),
    );
    expect(out).toEqual({ ok: false, result: { status: 'unknown', why: 'it did not answer in time', method: 'POST' } });
  });

  it('rethrows every other failure — a real failure is still one', async () => {
    const real = new McpToolError('HTTP 400');
    await expect(
      writeOrUnknown(
        async () => {
          throw real;
        },
        () => 'unknown',
      ),
    ).rejects.toBe(real);
  });

  it('awaits an async result builder', async () => {
    const out = await writeOrUnknown(
      async () => {
        throw dropped();
      },
      async (_e, why) => why,
    );
    expect(out).toEqual({ ok: false, result: 'the connection dropped' });
  });
});

describe('unknownOutcomeReason', () => {
  it('says the far side did not answer in time for a timeout (outlook / teams)', () => {
    expect(unknownOutcomeReason(timedOut())).toBe('it did not answer in time');
  });

  it('says the connection dropped when nothing answered', () => {
    expect(unknownOutcomeReason(dropped())).toBe('the connection dropped');
  });

  it('names the status a 5xx answered with, after what was sent (teams)', () => {
    expect(unknownOutcomeReason(answered5xx())).toBe('it answered HTTP 502 after the request was sent');
    expect(unknownOutcomeReason(answered5xx(), { sent: 'the post' })).toBe('it answered HTTP 502 after the post was sent');
  });
});

describe('writeOutcomeStatus', () => {
  it('reads the HTTP status behind the unknown outcome, if any', () => {
    expect(writeOutcomeStatus(answered5xx())).toBe(502);
    expect(writeOutcomeStatus(timedOut())).toBeUndefined();
    expect(writeOutcomeStatus(dropped())).toBeUndefined();
  });
});
