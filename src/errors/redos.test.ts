import { describe, expect, it } from 'vitest';

import { ERROR_REDACTION_INPUT_MAX, redactSecrets, truncateErrorMessage } from './index.js';

// Guards against catastrophic backtracking in the redaction chain. It is the
// FIRST step of truncateErrorMessage, which formatApiError feeds the WHOLE
// upstream body — so a hostile or proxied upstream can pin the single-threaded
// MCP process with one response if any pattern here is superlinear
// (fleet audit 2026-09-24 SEC-1: HEADER_SECRET_RE took 7.5 s on 200 KB of
// `x-`; bounded it takes ~12 ms). Budgets are ~8x the measured bounded time
// and ~50x under the vulnerable one, so they discriminate without flaking.

function elapsedMs(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

describe('redactSecrets ReDoS resistance', () => {
  it('is linear on 200 KB of `x-` runs (the header-name prefix with no colon)', () => {
    const evil = 'x-'.repeat(100_000);
    expect(elapsedMs(() => redactSecrets(evil))).toBeLessThan(100);
  });

  it('is linear on 200 KB of `x-a-` runs', () => {
    const evil = 'x-a-'.repeat(50_000);
    expect(elapsedMs(() => redactSecrets(evil))).toBeLessThan(100);
  });

  it('is linear on 200 KB of quoted `"x-` JSON-key prefixes', () => {
    const evil = '"x-'.repeat(66_000);
    expect(elapsedMs(() => redactSecrets(evil))).toBeLessThan(100);
  });

  it.each([
    ['a-', 'a-'.repeat(100_000)], // a base64url run with no `.`: the JWT scan must start once per run, not per `\\b`
    ['sk-', 'sk-'.repeat(66_000)],
    ['xoxb-', 'xoxb-'.repeat(40_000)],
    ['cookie:', 'cookie:'.repeat(28_000)], // header starts with no `=`: each scan must stop at the next `:`
    ['set-cookie:', 'set-cookie:'.repeat(18_000)],
    ['aaaaaaaaaaa.', 'aaaaaaaaaaa.'.repeat(16_000)],
    // PRIV-1 additions: the `x-` query-param branch, and the JSON cookie
    // rules with an unterminated array/string after every key.
    ['?x-', `?${'x-'.repeat(100_000)}`],
    ['&x-a-', '&x-a-'.repeat(40_000)],
    ['"cookie":[', '"cookie":['.repeat(20_000)],
    ['"cookie":["', '"cookie":["'.repeat(18_000)],
    ['"set-cookie":"\\', '"set-cookie":"\\'.repeat(14_000)],
    ['"token":1', '"token":1'.repeat(22_000)],
  ])('is linear on 200 KB of `%s` runs', (_label, evil) => {
    expect(elapsedMs(() => redactSecrets(evil))).toBeLessThan(100);
  });

  it('still redacts a JWT wherever it sits, and cookie values behind a header', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.abcDEF123_-xyz';
    for (const wrap of [(t: string) => t, (t: string) => `token=${t}&x=1`, (t: string) => `"jwt":"${t}"`, (t: string) => `(${t})`]) {
      const out = redactSecrets(wrap(jwt));
      expect(out).not.toContain('eyJhbGci');
      expect(out).toContain('[REDACTED]');
    }
    expect(redactSecrets('Cookie: sid=abc:def; theme=dark')).toBe('Cookie: sid=[REDACTED]; theme=[REDACTED]');
    expect(redactSecrets('Set-Cookie: sid=a:b:c; Path=/; HttpOnly')).toBe('Set-Cookie: sid=[REDACTED]; Path=/; HttpOnly');
  });

  it('still redacts the header shapes the bound must not lose', () => {
    for (const [header, secret] of [
      ['X-Api-Key: SECRET-abc123', 'SECRET-abc123'],
      ['X-Goog-Api-Key: SECRET-zz99', 'SECRET-zz99'],
      ['x_auth_token: SECRET-t1', 'SECRET-t1'],
      ['X-Amz-Security-Token: SECRET-aws', 'SECRET-aws'],
      ['Api-Key: SECRET-k', 'SECRET-k'],
    ] as const) {
      const out = redactSecrets(`error: ${header}`);
      expect(out).not.toContain(secret);
      expect(out).toContain('[REDACTED]');
    }
  });

  it('keeps `token: expired`-style prose untouched', () => {
    expect(redactSecrets('token: expired; retry later')).toBe('token: expired; retry later');
  });
});

describe('truncateErrorMessage input cap (defence in depth)', () => {
  it('caps the body it redacts at ERROR_REDACTION_INPUT_MAX before running the chain', () => {
    expect(ERROR_REDACTION_INPUT_MAX).toBe(64 * 1024);
    // A 4 MB natural body: the chain only ever sees the first 64 KB, so this
    // stays in single-digit ms even though every pattern is run.
    const big = 'The request failed because the upstream returned an unexpected shape. '.repeat(60_000);
    expect(big.length).toBeGreaterThan(4_000_000);
    expect(elapsedMs(() => truncateErrorMessage(big))).toBeLessThan(50);
  });

  it('still redacts a secret inside the capped window', () => {
    const body = `${'a'.repeat(60_000)} Bearer abcdefghijklmnop`;
    const out = truncateErrorMessage(body, 70_000);
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).toContain('Bearer [REDACTED]');
  });

  it('honours a `max` larger than the cap (the cap never clips below max)', () => {
    const body = 'b'.repeat(ERROR_REDACTION_INPUT_MAX + 10);
    expect(truncateErrorMessage(body, ERROR_REDACTION_INPUT_MAX + 10)).toBe(body);
  });
});
