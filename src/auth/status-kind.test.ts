/**
 * auth's throwers declare a structured `kind` beside `status` (fleet audit
 * 2026-09, cluster 8), so a rejected grant and an outage are told apart
 * without reading the message.
 */
import { describe, it, expect } from 'vitest';
import { errorKindOf } from '../errors/index.js';
import { OAuth2RefreshError, createOAuth2Refresher } from './index.js';

describe('OAuth2RefreshError kind', () => {
  it('a 4xx rejection (invalid_grant is a 400) is credential_rejected', () => {
    for (const status of [400, 401, 403]) {
      const err = new OAuth2RefreshError(status, 'x');
      expect(err.status).toBe(status);
      expect(err.kind).toBe('credential_rejected');
    }
  });

  it('a 5xx, 408 or 429 is http — the grant was never judged dead', () => {
    for (const status of [500, 503, 408, 429]) {
      expect(new OAuth2RefreshError(status, 'x').kind).toBe('http');
    }
  });

  it('is what the refresher throws', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const refresh = createOAuth2Refresher({ endpoint: 'https://svc.test/token', refreshToken: 'rt', fetchImpl });
    const err = await refresh().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OAuth2RefreshError);
    expect(errorKindOf(err)).toBe('credential_rejected');
  });
});
