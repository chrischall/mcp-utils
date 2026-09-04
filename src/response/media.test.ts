import { describe, it, expect } from 'vitest';
import { stripMediaUrls } from './media.js';

describe('what it removes', () => {
  it('drops the media keys that made a 187 KB splitwise response unreturnable', () => {
    // The real shape: 60% of that payload was these four keys.
    const group = {
      id: 1,
      name: 'Household',
      avatar: { small: 'https://s3/a.png', medium: 'https://s3/b.png' },
      tall_avatar: { xlarge: 'https://s3/c.png' },
      cover_photo: { xxlarge: 'https://s3/d.png' },
      members: [{ id: 2, first_name: 'A', picture: { medium: 'https://s3/e.png' }, balance: [] }],
    };
    expect(stripMediaUrls(group)).toEqual({
      id: 1,
      name: 'Household',
      members: [{ id: 2, first_name: 'A', balance: [] }],
    });
  });

  it('drops a bare image URL under a key that does not look like media', () => {
    expect(stripMediaUrls({ href: 'https://cdn.example.com/x/photo-9.jpg', id: 3 })).toEqual({ id: 3 });
  });

  it('recurses through arrays and nested objects', () => {
    const out = stripMediaUrls({ a: [{ b: { icon: 'x', keepMe: 1 } }] });
    expect(out).toEqual({ a: [{ b: { keepMe: 1 } }] });
  });
});

describe('what it must NOT remove', () => {
  it('keeps null — an absent key and a null one are not the same fact', () => {
    // ofw-mcp emits `viewedAt: null` to say "never opened", which is evidence
    // in a custody record. Dropping nulls buys three percentage points on the
    // measured payload and costs that distinction; it is deliberately not done.
    expect(stripMediaUrls({ viewedAt: null, read: false })).toEqual({ viewedAt: null, read: false });
  });

  it('keeps a PAGE url, which is the whole point of most links', () => {
    const page = { url: 'https://www.splitwise.com/expenses/4666326570', web: 'https://booli.se/bostad/1' };
    expect(stripMediaUrls(page)).toEqual(page);
  });

  it('keeps empty strings, zeroes and false — falsy is not absent', () => {
    const v = { a: '', b: 0, c: false, d: [] };
    expect(stripMediaUrls(v)).toEqual(v);
  });

  it('keeps a receipt/attachment URL when the caller asks to keep that key', () => {
    // The escape hatch for a payload that mixes a decorative avatar with an
    // image the caller actually wants.
    const v = { receipt: 'https://splitwise.com/r/1.jpeg', avatar: 'https://s3/a.png' };
    expect(stripMediaUrls(v, { keep: ['receipt'] })).toEqual({ receipt: 'https://splitwise.com/r/1.jpeg' });
  });

  it('leaves a Date alone rather than rebuilding it from its keys', () => {
    const d = new Date('2026-09-04T00:00:00Z');
    expect(stripMediaUrls({ at: d }).at).toBe(d);
  });

  it('never mutates its input — several repos hand it live cache rows', () => {
    const src = { id: 1, avatar: 'https://s3/a.png', nested: { icon: 'x', n: 2 } };
    const copy = JSON.parse(JSON.stringify(src));
    stripMediaUrls(src);
    expect(src).toEqual(copy);
  });

  it('passes a primitive or an array through at the top level', () => {
    expect(stripMediaUrls('hello')).toBe('hello');
    expect(stripMediaUrls([{ icon: 1, n: 2 }])).toEqual([{ n: 2 }]);
    expect(stripMediaUrls(null)).toBeNull();
  });

  it('never touches whitespace inside a value', () => {
    const body = 'Line one.\n\n  Indented.   ';
    expect(stripMediaUrls({ body }).body).toBe(body);
  });
});
