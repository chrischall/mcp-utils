/**
 * TokenManager's "nothing to authenticate with" failure declares
 * `kind: 'no_credential'` (fleet audit 2026-09, cluster 8), so a caller or
 * the credential healthcheck tells them apart from a rejected credential
 * without matching the message.
 */
import { describe, it, expect, vi } from 'vitest';
import { McpToolError, errorKindOf } from '../errors/index.js';
import { TokenManager } from './index.js';

describe('TokenManager no_credential errors', () => {
  it('no refresh token to spend', async () => {
    const tm = new TokenManager({ initial: { accessToken: 'AT', expiresAt: -1 }, refresh: vi.fn() });
    const err = await tm.getAccessToken().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpToolError);
    expect(errorKindOf(err)).toBe('no_credential');
    expect((err as Error).message).toBe('TokenManager: cannot refresh — no refresh token is available.');
  });

});
