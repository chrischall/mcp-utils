/**
 * fleet-audit#1405: a 5xx answered AFTER a non-idempotent write was sent is
 * outcome-unknown, not a hard failure — a gateway that lost or timed out the
 * origin's answer (502/504), or a backend that may have committed before it
 * failed (500/503). `createApiClient` used to throw a plain `ApiError` for
 * it, so `writeOrUnknown` rethrew it and the model was told the write FAILED:
 * office-outlook-mcp's `sendMail` invited a second copy. The donor,
 * microsoft-teams-mcp `chatsvc.ts#checkWriteStatus`, maps every 5xx on a
 * write to `WriteOutcomeUnknownError` with the status on `cause`.
 */
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  EdgeBlockedError,
  WriteOutcomeUnknownError,
  createApiClient,
  unknownOutcomeReason,
  writeOrUnknown,
  writeOutcomeStatus,
  type ApiClientOptions,
} from './index.js';

const answering = (status: number, body = 'gateway timeout', headers: Record<string, string> = {}) =>
  (() => Promise.resolve(new Response(body, { status, headers }))) as unknown as typeof fetch;

function client(extra: Partial<ApiClientOptions> = {}) {
  return createApiClient({
    baseUrl: 'https://x.test',
    getToken: () => 't',
    serviceName: 'Svc',
    retry: { count: 0, delayMs: 0 },
    ...extra,
  });
}

const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );

describe('createApiClient: a 5xx after a sent write is outcome-unknown (fleet-audit#1405)', () => {
  it('a 504 on POST throws WriteOutcomeUnknownError with the ApiError as cause', async () => {
    const err = await settle(client({ fetchImpl: answering(504) }).fetchJson('POST', '/send', { body: { a: 1 } }));
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    const unknown = err as WriteOutcomeUnknownError;
    expect(unknown.method).toBe('POST');
    expect(unknown.timedOut).toBe(false);
    expect(unknown.retrySafe).toBe(false);
    expect(unknown.cause).toBeInstanceOf(ApiError);
    expect((unknown.cause as ApiError).status).toBe(504);
    expect(writeOutcomeStatus(unknown)).toBe(504);
    expect(unknown.message).toBe(
      'POST to Svc failed: Svc error 504 for POST /send: gateway timeout — the write may already have been applied (outcome is unknown).',
    );
  });

  it('writeOrUnknown now yields the "answered HTTP N after … was sent" reason for a library client', async () => {
    const api = client({ fetchImpl: answering(504) });
    const out = await writeOrUnknown(
      () => api.fetchJson('POST', '/send', { body: {} }),
      (err, reason) => ({ status: 'unknown', reason, httpStatus: writeOutcomeStatus(err) }),
    );
    expect(out).toEqual({
      ok: false,
      result: { status: 'unknown', reason: 'it answered HTTP 504 after the request was sent', httpStatus: 504 },
    });
    const err = await settle(api.fetchJson('POST', '/send'));
    expect(unknownOutcomeReason(err as WriteOutcomeUnknownError, { sent: 'the mail' })).toBe(
      'it answered HTTP 504 after the mail was sent',
    );
  });

  for (const status of [500, 502, 503, 504, 507, 520, 524]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post'] as const) {
      it(`${status} on ${method} is outcome-unknown on fetchJson, fetchHtml and fetchRaw`, async () => {
        const api = client({ fetchImpl: answering(status, 'boom') });
        for (const call of [api.fetchJson, api.fetchHtml, api.fetchRaw] as const) {
          const err = await settle(call(method, '/a'));
          expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
          expect(writeOutcomeStatus(err as WriteOutcomeUnknownError)).toBe(status);
        }
      });
    }
  }

  it('an exhausted 5xx retry on a write is outcome-unknown too', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(new Response('busy', { status: 503 }));
    }) as unknown as typeof fetch;
    const err = await settle(
      client({ fetchImpl, retry: { count: 2, delayMs: 0, statuses: [429, 503] }, sleep: async () => {} }).fetchJson('POST', '/a'),
    );
    expect(calls).toBe(3);
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(writeOutcomeStatus(err as WriteOutcomeUnknownError)).toBe(503);
  });

  it('a configured 5xx retry is unchanged: a 503 then a 200 succeeds', async () => {
    const responses = [new Response('busy', { status: 503 }), new Response('{"ok":true}', { status: 200 })];
    const fetchImpl = (() => Promise.resolve(responses.shift())) as unknown as typeof fetch;
    const api = client({ fetchImpl, retry: { count: 1, delayMs: 0, statuses: [429, 503] }, sleep: async () => {} });
    await expect(api.fetchJson('POST', '/a')).resolves.toEqual({ ok: true });
  });

  it('uses writeOutcomeHint', async () => {
    const err = await settle(client({ fetchImpl: answering(502), writeOutcomeHint: 'check Sent Items' }).fetchJson('POST', '/a'));
    expect((err as WriteOutcomeUnknownError).hint).toBe('check Sent Items');
  });
});

describe('createApiClient: what a 5xx/4xx on a write still is', () => {
  for (const status of [400, 403, 404, 409, 422]) {
    it(`a ${status} on POST stays a hard ApiError (the server refused it)`, async () => {
      const err = await settle(client({ fetchImpl: answering(status, 'nope') }).fetchJson('POST', '/a'));
      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
      expect((err as ApiError).status).toBe(status);
    });
  }

  for (const status of [501, 505]) {
    it(`a ${status} on POST stays a hard ApiError (the request was refused as such, never handled)`, async () => {
      const err = await settle(client({ fetchImpl: answering(status, 'nope') }).fetchJson('POST', '/a'));
      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
    });
  }

  for (const method of ['GET', 'HEAD', 'OPTIONS'] as const) {
    it(`a 503 on ${method} stays an ApiError (a read is safe to retry)`, async () => {
      const err = await settle(client({ fetchImpl: answering(503) }).fetchRaw(method, '/a'));
      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
    });
  }

  it('idempotent: true keeps a 503 on POST a plain ApiError', async () => {
    const err = await settle(client({ fetchImpl: answering(503) }).fetchJson('POST', '/search', { idempotent: true }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it('writeOutcomeUnknown: false keeps a 503 on POST a plain ApiError', async () => {
    const err = await settle(client({ fetchImpl: answering(503), writeOutcomeUnknown: false }).fetchJson('POST', '/a'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it('an edge refusal page on a 503 stays EdgeBlockedError (it never reached the origin)', async () => {
    const page = '<html><head><title>Just a moment...</title></head><body>cf-chl-bypass challenge-platform</body></html>';
    const err = await settle(
      client({ fetchImpl: answering(503, page, { 'content-type': 'text/html', server: 'cloudflare', 'cf-mitigated': 'challenge' }) }).fetchJson(
        'POST',
        '/a',
      ),
    );
    expect(err).toBeInstanceOf(EdgeBlockedError);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it('an onErrorResponse error wins: a consumer can keep a 5xx a hard failure', async () => {
    const mine = new ApiError(503, 'Svc is down for maintenance; nothing was sent');
    const err = await settle(
      client({ fetchImpl: answering(503), onErrorResponse: ({ status }) => (status === 503 ? mine : undefined) }).fetchJson('POST', '/a'),
    );
    expect(err).toBe(mine);
  });

  it('an onErrorResponse that falls through leaves the default: outcome-unknown', async () => {
    const err = await settle(client({ fetchImpl: answering(502), onErrorResponse: () => undefined }).fetchJson('POST', '/a'));
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
  });
});
