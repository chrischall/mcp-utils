import { describe, expect, it } from 'vitest';
import { mergeSetCookies } from '../index.js';

const jarOf = (entries: Record<string, string> = {}) => new Map(Object.entries(entries));

describe('mergeSetCookies', () => {
  it('sets a new cookie and reports a change', () => {
    const jar = jarOf();
    expect(mergeSetCookies(jar, ['sid=abc; Path=/; HttpOnly'])).toBe(true);
    expect(Object.fromEntries(jar)).toEqual({ sid: 'abc' });
  });

  it('overwrites an existing cookie by name', () => {
    const jar = jarOf({ sid: 'old', keep: '1' });
    expect(mergeSetCookies(jar, ['sid=new'])).toBe(true);
    expect(Object.fromEntries(jar)).toEqual({ sid: 'new', keep: '1' });
  });

  it('deletes a cookie on Max-Age=0', () => {
    const jar = jarOf({ sid: 'abc', keep: '1' });
    expect(mergeSetCookies(jar, ['sid=gone; Max-Age=0; Path=/'])).toBe(true);
    expect(jar.has('sid')).toBe(false);
    expect(jar.get('keep')).toBe('1');
  });

  it('deletes a cookie on a 1970 Expires', () => {
    const jar = jarOf({ sid: 'abc' });
    expect(mergeSetCookies(jar, ['sid=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT'])).toBe(true);
    expect(jar.size).toBe(0);
  });

  it('deletes a cookie on an empty value instead of storing ""', () => {
    const jar = jarOf({ sid: 'abc' });
    expect(mergeSetCookies(jar, ['sid=; Path=/'])).toBe(true);
    expect(jar.has('sid')).toBe(false);
  });

  it('returns false for a delete of an absent name', () => {
    const jar = jarOf({ keep: '1' });
    expect(mergeSetCookies(jar, ['sid=; Max-Age=0', 'other=x; Expires=Thu, 01-Jan-1970 00:00:00 GMT'])).toBe(false);
    expect(Object.fromEntries(jar)).toEqual({ keep: '1' });
  });

  it('returns false when the value is unchanged', () => {
    const jar = jarOf({ sid: 'abc' });
    expect(mergeSetCookies(jar, ['sid=abc; Path=/'])).toBe(false);
    expect(jar.get('sid')).toBe('abc');
  });

  it('splits a comma-joined string safely around a comma inside Expires', () => {
    const jar = jarOf();
    const joined = 'a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/, b=2; Path=/';
    expect(mergeSetCookies(jar, joined)).toBe(true);
    expect(Object.fromEntries(jar)).toEqual({ a: '1', b: '2' });
  });

  it('reads a Headers object via getSetCookie()', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT');
    headers.append('set-cookie', 'b=; Max-Age=0');
    const jar = jarOf({ b: 'old' });
    expect(mergeSetCookies(jar, headers)).toBe(true);
    expect(Object.fromEntries(jar)).toEqual({ a: '1' });
  });

  it('treats null and malformed entries as no change', () => {
    const jar = jarOf({ sid: 'abc' });
    expect(mergeSetCookies(jar, null)).toBe(false);
    expect(mergeSetCookies(jar, ['=nameless', 'noequals'])).toBe(false);
    expect(Object.fromEntries(jar)).toEqual({ sid: 'abc' });
  });
});
