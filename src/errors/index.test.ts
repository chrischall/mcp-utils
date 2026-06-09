import { describe, it, expect } from 'vitest';
import {
  McpToolError,
  SessionNotAuthenticatedError,
  BotWallError,
  RateLimitError,
  UnreachableError,
  ModeMismatchError,
  createHelpfulError,
  wrapToolError,
  truncateErrorMessage,
  redactSecrets,
} from './index.js';
import { redactSecrets as redactSecretsFromRoot } from '../index.js';

describe('McpToolError', () => {
  it('is an Error subclass carrying a hint and name', () => {
    const err = new McpToolError('something broke', { hint: 'do X to fix' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.message).toBe('something broke');
    expect(err.hint).toBe('do X to fix');
    expect(err.name).toBe('McpToolError');
  });

  it('allows a hint-less construction', () => {
    const err = new McpToolError('plain');
    expect(err.hint).toBeUndefined();
    expect(err.message).toBe('plain');
  });

  it('has a captured stack', () => {
    const err = new McpToolError('boom');
    expect(typeof err.stack).toBe('string');
  });
});

describe('SessionNotAuthenticatedError', () => {
  it('extends McpToolError and carries a remediation message', () => {
    const err = new SessionNotAuthenticatedError('Compass', 'compass.com');
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.name).toBe('SessionNotAuthenticatedError');
    expect(err.message).toMatch(/Compass/);
    expect(err.message).toMatch(/compass\.com/);
    expect(err.message.toLowerCase()).toMatch(/sign in/);
    // hint is actionable
    expect(err.hint).toBeDefined();
  });

  it('falls back to a generic message when no service is given', () => {
    const err = new SessionNotAuthenticatedError();
    expect(err.message.toLowerCase()).toMatch(/sign(ed)? in/);
  });
});

describe('BotWallError', () => {
  it('extends McpToolError and is retryable with a default wait', () => {
    const err = new BotWallError('/homedetails/123_zpid/');
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.name).toBe('BotWallError');
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.message).toMatch(/homedetails/);
    // distinguishes transient bot-wall from a missing resource
    expect(err.message.toLowerCase()).toMatch(/back off|retry|rate.?limit/);
  });

  it('accepts an explicit retry-after', () => {
    const err = new BotWallError('/x', 90);
    expect(err.retryAfterSeconds).toBe(90);
    expect(err.message).toMatch(/90/);
  });
});

describe('RateLimitError', () => {
  it('extends McpToolError and carries retryAfterSeconds', () => {
    const err = new RateLimitError('Zola', 2);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.name).toBe('RateLimitError');
    expect(err.retryAfterSeconds).toBe(2);
    expect(err.message).toMatch(/Zola/);
    expect(err.message.toLowerCase()).toMatch(/rate.?limit/);
  });

  it('works without an explicit retry-after', () => {
    const err = new RateLimitError('Zola');
    expect(err.retryAfterSeconds).toBeUndefined();
    expect(err.message.toLowerCase()).toMatch(/rate.?limit/);
  });
});

describe('UnreachableError', () => {
  it('extends McpToolError and carries the upstream status', () => {
    const err = new UnreachableError('SignUpGenius', 503);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.name).toBe('UnreachableError');
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/SignUpGenius/);
    expect(err.message).toMatch(/503/);
  });

  it('omits the status from the message when none is given', () => {
    const err = new UnreachableError('SignUpGenius');
    expect(err.status).toBeUndefined();
    expect(err.message).toMatch(/SignUpGenius/);
  });
});

describe('ModeMismatchError', () => {
  it('extends McpToolError and explains the mode gap', () => {
    const err = new ModeMismatchError('session', 'key', 'Slot reports');
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.name).toBe('ModeMismatchError');
    expect(err.currentMode).toBe('session');
    expect(err.requiredMode).toBe('key');
    expect(err.feature).toBe('Slot reports');
    expect(err.message).toMatch(/Slot reports/);
    expect(err.message).toMatch(/key/);
    expect(err.message).toMatch(/session/);
  });
});

describe('createHelpfulError', () => {
  it('builds an McpToolError with a hint', () => {
    const err = createHelpfulError('nope', { hint: 'try again' });
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.message).toBe('nope');
    expect(err.hint).toBe('try again');
  });

  it('works without options', () => {
    const err = createHelpfulError('nope');
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.hint).toBeUndefined();
  });
});

describe('truncateErrorMessage', () => {
  it('leaves short text untouched', () => {
    expect(truncateErrorMessage('short')).toBe('short');
  });

  it('truncates to the default max of 500 and marks it', () => {
    const long = 'a'.repeat(1000);
    const out = truncateErrorMessage(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toMatch(/truncated/i);
    // the retained prefix is exactly `max` characters of the original
    expect(out.startsWith('a'.repeat(500))).toBe(true);
  });

  it('respects a custom max', () => {
    const out = truncateErrorMessage('b'.repeat(50), 10);
    expect(out.startsWith('b'.repeat(10))).toBe(true);
    expect(out).toMatch(/truncated/i);
  });

  it('does not append the marker when text is exactly max length', () => {
    const out = truncateErrorMessage('c'.repeat(10), 10);
    expect(out).toBe('c'.repeat(10));
  });

  it('coerces non-string input to a string', () => {
    expect(truncateErrorMessage(undefined as unknown as string)).toBe('');
    expect(truncateErrorMessage(null as unknown as string)).toBe('');
    expect(truncateErrorMessage(12345 as unknown as string)).toBe('12345');
  });

  it('redacts bearer tokens before surfacing the message (security)', () => {
    const leak = 'failed: Authorization: Bearer eyJhbGciOiJIUzI1Ni2345.abcDEF.signature-here and more';
    const out = truncateErrorMessage(leak);
    expect(out).not.toMatch(/eyJhbGciOiJIUzI1Ni2345/);
    expect(out.toLowerCase()).toMatch(/bearer \[redacted\]/);
  });

  it('redacts a standalone JWT-looking token (security)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = truncateErrorMessage(`token was ${jwt} oops`);
    expect(out).not.toContain(jwt);
    expect(out).toMatch(/\[redacted\]/i);
  });

  it('truncates AFTER redacting so a token cannot survive at the boundary', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const padded = 'x'.repeat(480) + ' ' + jwt;
    const out = truncateErrorMessage(padded, 500);
    expect(out).not.toContain(jwt);
  });
});

describe('redactSecrets', () => {
  it('is exported from the package root barrel', () => {
    expect(redactSecretsFromRoot).toBe(redactSecrets);
  });

  it('redacts Set-Cookie values but keeps the cookie name and attributes', () => {
    const out = redactSecrets('upstream said: Set-Cookie: session=s%3AabcDEF123.sig; Path=/; HttpOnly');
    expect(out).toBe('upstream said: Set-Cookie: session=[REDACTED]; Path=/; HttpOnly');
  });

  it('redacts every pair in a Cookie header, keeping the names', () => {
    const out = redactSecrets('request had Cookie: sid=deadbeef12345; csrftoken=Xyz789AbC; theme=dark');
    expect(out).toBe('request had Cookie: sid=[REDACTED]; csrftoken=[REDACTED]; theme=[REDACTED]');
  });

  it('redacts Authorization: Basic credentials', () => {
    const out = redactSecrets('sent Authorization: Basic dXNlcjpwYXNzd29yZA== to upstream');
    expect(out).not.toContain('dXNlcjpwYXNzd29yZA==');
    expect(out).toMatch(/basic \[REDACTED\]/i);
  });

  it('redacts OpenAI-style sk- keys', () => {
    const key = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const out = redactSecrets(`bad key ${key} rejected`);
    expect(out).toBe('bad key [REDACTED] rejected');
  });

  it('redacts Anthropic-style sk-ant- keys', () => {
    const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz-0123456789AbCdEfGhIjKlMnOp';
    const out = redactSecrets(`401 for ${key}`);
    expect(out).toBe('401 for [REDACTED]');
  });

  it('redacts dash-charset keys even when they end in a dash (\\b cannot anchor there)', () => {
    const sk = 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz012345678-';
    const xox = 'xoxb-1234567890-AbCdEf-';
    expect(redactSecrets(`key ${sk} rejected`)).toBe('key [REDACTED] rejected');
    expect(redactSecrets(`token ${xox} rejected`)).toBe('token [REDACTED] rejected');
  });

  it('redacts GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)', () => {
    for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
      const token = `${prefix}_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`;
      expect(redactSecrets(`token ${token} expired`)).toBe('token [REDACTED] expired');
    }
  });

  it('redacts Slack xox tokens', () => {
    // Assembled at runtime so the fixture can't trip GitHub push protection.
    const token = ['xoxb', '1234567890123', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
    expect(redactSecrets(`slack said no: ${token}`)).toBe('slack said no: [REDACTED]');
  });

  it('redacts Google AIza keys (39 chars total)', () => {
    const key = 'AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tUvW';
    expect(key).toHaveLength(39);
    expect(redactSecrets(`googleapis rejected ${key}`)).toBe('googleapis rejected [REDACTED]');
  });

  it('redacts AWS access key ids (AKIA + 16)', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    expect(key).toHaveLength(20);
    expect(redactSecrets(`aws denied ${key}`)).toBe('aws denied [REDACTED]');
  });

  it('redacts webhook signing secrets (whsec_)', () => {
    const key = 'whsec_AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    expect(redactSecrets(`verify failed for ${key}`)).toBe('verify failed for [REDACTED]');
  });

  it('redacts secret-bearing query params in URLs', () => {
    const out = redactSecrets(
      'GET https://api.example.com/cb?access_token=AbC123dEf&state=ok&api_key=zZyYxX1&token=t0ps3cret failed',
    );
    expect(out).toBe('GET https://api.example.com/cb?access_token=[REDACTED]&state=ok&api_key=[REDACTED]&token=[REDACTED] failed');
  });

  it('redacts key/sig/signature/client_secret/refresh_token/apikey query params', () => {
    const out = redactSecrets(
      'url: https://x.test/a?key=AbC123&sig=ZxY987&signature=QwE456&client_secret=sEcReT1&refresh_token=rT0k3n&apikey=K3y123 end',
    );
    expect(out).toBe(
      'url: https://x.test/a?key=[REDACTED]&sig=[REDACTED]&signature=[REDACTED]&client_secret=[REDACTED]&refresh_token=[REDACTED]&apikey=[REDACTED] end',
    );
  });

  it('does not redact ordinary prose mentioning token/key/cookie', () => {
    const prose = 'the token expired; rotate your key and clear the cookie jar';
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('does not redact short hex ids, version strings, or UUIDs', () => {
    const prose = 'id a3f9c2 on v1.2.3-beta failed for 550e8400-e29b-41d4-a716-446655440000';
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('does not redact key=value outside a URL query context', () => {
    const prose = 'config entry key=primary was ignored; sort key=name applies';
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('does not redact non-secret query params', () => {
    const url = 'https://api.example.com/v1/items?page=2&limit=10&sort=asc';
    expect(redactSecrets(url)).toBe(url);
  });

  it('still redacts Bearer tokens and JWTs (existing behavior)', () => {
    const out = redactSecrets('Bearer eyJhbGciOiJIUzI1Ni2345.abcDEFghij.signature-here');
    expect(out.toLowerCase()).toContain('bearer [redacted]');
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactSecrets(`token was ${jwt}`)).toBe('token was [REDACTED]');
  });
});

describe('wrapToolError', () => {
  it('prepends the tool name to an Error message and preserves the hint', () => {
    const original = new McpToolError('underlying failure', { hint: 'fix me' });
    const wrapped = wrapToolError('compass_get_property', original);
    expect(wrapped).toBeInstanceOf(McpToolError);
    expect(wrapped.message).toMatch(/compass_get_property/);
    expect(wrapped.message).toMatch(/underlying failure/);
    expect(wrapped.hint).toBe('fix me');
  });

  it('wraps a plain Error', () => {
    const wrapped = wrapToolError('zola_get_budget', new Error('boom'));
    expect(wrapped).toBeInstanceOf(McpToolError);
    expect(wrapped.message).toMatch(/zola_get_budget/);
    expect(wrapped.message).toMatch(/boom/);
  });

  it('wraps a non-Error thrown value', () => {
    const wrapped = wrapToolError('t', 'string failure');
    expect(wrapped.message).toMatch(/t/);
    expect(wrapped.message).toMatch(/string failure/);
  });

  it('preserves the original error as the cause', () => {
    const original = new Error('root');
    const wrapped = wrapToolError('t', original);
    expect(wrapped.cause).toBe(original);
  });

  it('truncates/redacts the wrapped message (security)', () => {
    const wrapped = wrapToolError('t', new Error('Bearer eyJsecrettoken12345.payload.sig'));
    expect(wrapped.message).not.toMatch(/eyJsecrettoken12345/);
  });

  it('is idempotent on tool prefixing — does not double-prefix', () => {
    const once = wrapToolError('tool_x', new Error('boom'));
    const twice = wrapToolError('tool_x', once);
    const matches = twice.message.match(/tool_x/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
