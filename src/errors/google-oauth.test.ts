import { describe, expect, it } from 'vitest';

import { redactSecrets } from './index.js';

// fleet-audit#1160: Google OAuth2 access (`ya29.…`) and refresh (`1//…`) tokens,
// upstreamed from gogcli-mcp's local redactGoogleTokens. All values synthetic.

const ACCESS = 'ya29.a0Ad52N3FAKE-access_token.Value0123';
const REFRESH = '1//0eFAKE-refresh_Token.Value0123';

describe('redactSecrets — Google OAuth2 tokens', () => {
  it.each([
    ['bare in prose', `token is ${ACCESS} here`, ACCESS],
    ['refresh in prose', `refreshed with ${REFRESH} ok`, REFRESH],
    ['at start of string', `${ACCESS} expired`, ACCESS],
    ['refresh at start of string', `${REFRESH}`, REFRESH],
    ['form-encoded access (no ?/& context)', `access_token=${ACCESS}`, ACCESS],
    ['form-encoded refresh (no ?/& context)', `refresh_token=${REFRESH}`, REFRESH],
    ['after a colon', `grant:${REFRESH}`, REFRESH],
    ['in brackets', `[${REFRESH}]`, REFRESH],
    ['in parentheses', `(${ACCESS})`, ACCESS],
    ['quoted under a non-secret JSON key', `{"note":"used ${REFRESH}"}`, REFRESH],
    ['quoted alone under a non-secret key', `{"value":"${ACCESS}"}`, ACCESS],
    ['after a Bearer-less header', `X-Thing: ${ACCESS}`, ACCESS],
    ['on its own line', `line one\n${REFRESH}\nline three`, REFRESH],
  ])('redacts %s', (_label, input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    // The token's tail must not survive either (the whole shape is consumed).
    expect(out).not.toContain(secret.slice(8));
    expect(out).toContain('[REDACTED]');
  });

  it('redacts both shapes in one string', () => {
    const out = redactSecrets(`access ${ACCESS} refresh ${REFRESH}`);
    expect(out).toBe('access [REDACTED] refresh [REDACTED]');
  });

  it('does not touch a `1//` welded inside a base64 blob', () => {
    // A base64 payload containing `1//` mid-run is data, not a token: every
    // genuine token is delimited on its left by a non-base64 character.
    const blob = `AAAA1//abcdefghijklmnop${'QRSTuvwx'.repeat(4)}`;
    expect(redactSecrets(blob)).toBe(blob);
    const plus = `Zm9v+1//abcdefghijklmnopqrst`;
    expect(redactSecrets(plus)).toBe(plus);
    const slash = `Zm9v/1//abcdefghijklmnopqrst`;
    expect(redactSecrets(slash)).toBe(slash);
  });

  it('does not touch a `ya29.` welded to a preceding identifier', () => {
    const s = 'variable xya29.somethingLongEnoughHere';
    expect(redactSecrets(s)).toBe(s);
  });

  it.each([
    'see https://example.com/a/1//b for details', // `1//` preceded by `/`
    'ratio 1// 2', // nothing after the prefix
    'ratio 1//2', // too short to be a token
    'released ya29.1 last week', // too short to be a token
    'the ya29 project', // no dot
    'year 2029.01 forecast',
    'an OAuth consent URL https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps.googleusercontent.com&scope=openid',
  ])('leaves ordinary text alone: %s', (s) => {
    expect(redactSecrets(s)).toBe(s);
  });
});
