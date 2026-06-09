import { describe, it, expect } from 'vitest';
import {
  textResult,
  jsonResult,
  rawTextResult,
  imageResult,
  errorResult,
  flattenJsonApi,
  deepMapStringField,
} from './index.js';

describe('textResult', () => {
  it('wraps data as pretty-printed JSON text content', () => {
    expect(textResult({ a: 1 })).toEqual({
      content: [{ type: 'text', text: '{\n  "a": 1\n}' }],
    });
  });

  it('jsonResult is an alias for textResult', () => {
    expect(jsonResult).toBe(textResult);
  });
});

describe('rawTextResult', () => {
  it('returns the string unmodified', () => {
    expect(rawTextResult('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });
});

describe('imageResult', () => {
  it('returns an image content block', () => {
    expect(imageResult('Zm9v', 'image/png')).toEqual({
      content: [{ type: 'image', data: 'Zm9v', mimeType: 'image/png' }],
    });
  });
});

describe('errorResult', () => {
  it('sets isError and carries the message', () => {
    expect(errorResult('boom')).toEqual({
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    });
  });

  it('redacts secrets in the message (security)', () => {
    const res = errorResult('auth failed: Bearer eyJsecrettoken12345.payload.sig sent with Cookie: session=abc123def');
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).not.toContain('eyJsecrettoken12345');
    expect(text).not.toContain('abc123def');
    expect(text.toLowerCase()).toContain('bearer [redacted]');
    expect(text).toContain('Cookie: session=[REDACTED]');
    expect(res.isError).toBe(true);
  });

  it('does NOT truncate long messages (redaction only)', () => {
    const long = 'x'.repeat(2000);
    const res = errorResult(long);
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe(long);
    expect(text).not.toMatch(/truncated/i);
  });
});

describe('flattenJsonApi', () => {
  it('flattens a single JSON:API resource', () => {
    expect(flattenJsonApi({ data: { id: '7', type: 'frame', attributes: { name: 'Den' } } })).toEqual({
      name: 'Den',
      id: '7',
      type: 'frame',
    });
  });

  it('flattens an array of resources', () => {
    expect(
      flattenJsonApi({ data: [{ id: '1', type: 'x', attributes: { v: 1 } }] }),
    ).toEqual([{ v: 1, id: '1', type: 'x' }]);
  });

  it('passes through payloads without a data key', () => {
    expect(flattenJsonApi({ foo: 1 })).toEqual({ foo: 1 });
  });

  it('passes through primitives', () => {
    expect(flattenJsonApi('x')).toBe('x');
  });
});

describe('deepMapStringField', () => {
  it('rewrites the named string field at any depth, leaving other data alone', () => {
    const input = {
      total: 1,
      list: [{ id: 'a', d: '28-08-2025', nested: { d: '01-02-2020', keep: 7 } }],
      d: 5, // non-string value of the target key is left untouched
    };
    const out = deepMapStringField(input, 'd', (v) => `<${v}>`);
    expect(out.list[0].d).toBe('<28-08-2025>');
    expect(out.list[0].nested.d).toBe('<01-02-2020>');
    expect(out.list[0].nested.keep).toBe(7);
    expect(out.d).toBe(5);
    expect(out.total).toBe(1);
  });

  it('returns primitives and undefined unchanged', () => {
    expect(deepMapStringField('x', 'd', (v) => v + '!')).toBe('x');
    expect(deepMapStringField(undefined, 'd', (v) => v)).toBeUndefined();
  });
});
