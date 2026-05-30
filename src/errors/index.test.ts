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
} from './index.js';

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
