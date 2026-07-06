import { describe, expect, it } from 'vitest';

import { pruneUndefined, toArray } from './index.js';


describe('pruneUndefined', () => {
  it('drops undefined-valued keys, keeping everything else', () => {
    expect(pruneUndefined({ a: 1, b: undefined, c: 'x' })).toEqual({ a: 1, c: 'x' });
  });

  it('keeps null and falsy values (only undefined is "not provided")', () => {
    expect(pruneUndefined({ a: null, b: 0, c: '', d: false })).toEqual({
      a: null,
      b: 0,
      c: '',
      d: false,
    });
  });

  it('returns a new object and does not mutate the input', () => {
    const input = { a: 1, b: undefined };
    const out = pruneUndefined(input);
    expect(out).not.toBe(input);
    expect(Object.keys(input)).toContain('b');
  });

  it('is shallow: nested undefineds are left alone', () => {
    const nested = { x: undefined };
    expect(pruneUndefined({ a: nested })).toEqual({ a: nested });
  });
});

describe('toArray', () => {
  it('wraps a bare value', () => {
    expect(toArray('a')).toEqual(['a']);
  });

  it('passes an array through', () => {
    const arr = [1, 2];
    expect(toArray(arr)).toBe(arr);
  });

  it('maps null and undefined to []', () => {
    expect(toArray(null)).toEqual([]);
    expect(toArray(undefined)).toEqual([]);
  });

  it('wraps falsy non-nullish values', () => {
    expect(toArray(0)).toEqual([0]);
    expect(toArray('')).toEqual(['']);
  });
});
