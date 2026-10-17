import { describe, expect, it } from 'vitest';

import { redactValues, truncateErrorMessage } from './index.js';

// fleet-audit#1398: skylight-mcp's `scrubSecret` (calendars.ts) and
// iaqualink-mcp's `scrub` / `scrubText` (client.ts) remove a known credential
// VALUE from upstream text, because `redactSecrets` only matches secret SHAPES
// and a password or an opaque session id has none. These pin both donors.

describe('redactValues', () => {
  it('replaces every occurrence of a value with [REDACTED]', () => {
    expect(redactValues('pw=hunter2 and again hunter2', ['hunter2'])).toBe('pw=[REDACTED] and again [REDACTED]');
  });

  it('also replaces the JSON-escaped spelling, as it appears inside a stringified body (skylight)', () => {
    const secret = 'a"b\\c';
    const body = JSON.stringify({ echoed: secret });
    expect(body).toContain('a\\"b\\\\c');
    expect(redactValues(body, [secret])).toBe('{"echoed":"[REDACTED]"}');
  });

  it('can skip the JSON-escaped spelling', () => {
    const secret = 'a"b';
    expect(redactValues('raw a"b json a\\"b', [secret], { jsonEscaped: false })).toBe('raw [REDACTED] json a\\"b');
  });

  it('takes a custom placeholder (iaqualink uses [redacted])', () => {
    expect(redactValues('token=s3cr3t', ['s3cr3t'], { placeholder: '[redacted]' })).toBe('token=[redacted]');
  });

  it('scrubs several values — a password and live session tokens (iaqualink scrubText)', () => {
    const out = redactValues('pw=pass1 sid=SESSION-1 auth=AUTH-2', ['pass1', 'SESSION-1', 'AUTH-2']);
    expect(out).toBe('pw=[REDACTED] sid=[REDACTED] auth=[REDACTED]');
  });

  it('ignores undefined, null and empty values — an empty needle would splice the placeholder everywhere', () => {
    expect(redactValues('abc', [undefined, null, '', 'b'])).toBe('a[REDACTED]c');
    expect(redactValues('abc', [])).toBe('abc');
  });

  it('replaces the longest value first, so a value containing another leaves no fragment', () => {
    expect(redactValues('token=abcdef', ['abc', 'abcdef'])).toBe('token=[REDACTED]');
  });

  it('honours minLength, so a too-short value is left alone', () => {
    expect(redactValues('a cat', ['a', 'cat'], { minLength: 2 })).toBe('a [REDACTED]');
  });

  it('does not treat a value as a pattern', () => {
    expect(redactValues('x.*y and x.*y', ['x.*y'])).toBe('[REDACTED] and [REDACTED]');
    expect(redactValues('axby', ['x.*y'])).toBe('axby');
  });

  it('accepts any iterable of values', () => {
    expect(redactValues('one two', new Set(['one']))).toBe('[REDACTED] two');
  });
});

describe('truncateErrorMessage({ values })', () => {
  it('scrubs the values before the shape redactor and the cut (skylight: values, then redactSecrets)', () => {
    const out = truncateErrorMessage('upstream said: password hunter2 Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', 500, { values: ['hunter2'] });
    expect(out).toBe('upstream said: password [REDACTED] Authorization: Bearer [REDACTED]');
  });

  it('scrubs a value that straddles the cut, which scrubbing the truncated text could not (iaqualink truncated first)', () => {
    const secret = 'S'.repeat(20);
    const text = `${'x'.repeat(490)}${secret}`;
    const out = truncateErrorMessage(text, 500, { values: [secret] });
    expect(out).not.toContain('SSSS');
    expect(out).toBe(`${'x'.repeat(490)}[REDACTED]`);
  });

  it('passes the placeholder through', () => {
    expect(truncateErrorMessage('pw=hunter2', 500, { values: ['hunter2'], placeholder: '[redacted]' })).toBe('pw=[redacted]');
  });

  it('is unchanged without values', () => {
    expect(truncateErrorMessage('plain', 500, {})).toBe('plain');
    expect(truncateErrorMessage('plain', 500)).toBe('plain');
  });
});
