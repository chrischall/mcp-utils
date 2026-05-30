import { describe, it, expect } from 'vitest';
import {
  textResult,
  jsonResult,
  rawTextResult,
  imageResult,
  errorResult,
  flattenJsonApi,
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
