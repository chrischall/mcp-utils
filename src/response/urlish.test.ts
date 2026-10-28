import { describe, it, expect } from 'vitest';
import { stripUrlishKeys } from './urlish.js';
import * as root from '../index.js';

describe('stripUrlishKeys — what it removes', () => {
  // The insync-mcp cases (#4/#5/#6). Every one of these names is a reference,
  // a credential, or a signed fetch URL in some real upstream.
  const STRIPPED = [
    'FilePath', 'FileUrl', 'Url', 'URL', 'Uri', 'Src', 'Source', 'Link', 'Href',
    'Token', 'Secret', 'Key', 'AccessKey', 'SasToken', 'Signature', 'DownloadUrl',
    'url', 'file_path', 'S3URL', 'srcset',
  ];

  it.each(STRIPPED)('drops %s', (key) => {
    expect(stripUrlishKeys({ [key]: 'x', Index: 1 })).toEqual({ Index: 1 });
  });

  // The fail-open cases: a word-segment matcher has nothing to split in these,
  // so it KEPT them — and `FILEPATH` / `Thumbnailurl` are exactly the
  // session-authorized fetch URLs the filter exists to hide.
  it.each(['FILEPATH', 'filepath', 'Thumbnailurl', 'TOKENVALUE'])(
    'drops %s, which has no word boundary for a segmenter to find',
    (key) => {
      expect(stripUrlishKeys({ [key]: 'https://portal/x?sig=abc', Size: 3 })).toEqual({ Size: 3 });
    },
  );

  it('drops every url-ish key from a real attachment row at once', () => {
    const row = {
      Description: 'Lab results',
      FileName: 'labs.pdf',
      FileNotExit: false,
      Index: 0,
      Size: 1024,
      Thumbnail: true,
      FILEPATH: '/srv/docs/a.pdf',
      Thumbnailurl: 'https://portal/thumb?sig=abc',
      SasToken: 'sv=2020&sig=xyz',
    };
    expect(stripUrlishKeys(row)).toEqual({
      Description: 'Lab results',
      FileName: 'labs.pdf',
      FileNotExit: false,
      Index: 0,
      Size: 1024,
      Thumbnail: true,
    });
  });
});

describe('stripUrlishKeys — what it keeps', () => {
  it.each(['Description', 'FileName', 'FileNotExit', 'Index', 'Size', 'Thumbnail'])('keeps %s', (key) => {
    expect(stripUrlishKeys({ [key]: 'v' })).toEqual({ [key]: 'v' });
  });

  it('keeps values verbatim, including null and nested objects', () => {
    const nested = { url: 'https://inner', ok: 1 };
    const out = stripUrlishKeys({ Note: null, Meta: nested });
    expect(out).toEqual({ Note: null, Meta: nested });
    // One level only: a nested object is passed through by reference, unfiltered.
    expect(out.Meta).toBe(nested);
  });
});

describe('stripUrlishKeys — the documented cost of substring matching', () => {
  it.each(['Monkey', 'Keyboard', 'Pathway'])('drops %s (an ordinary word containing a token)', (key) => {
    expect(stripUrlishKeys({ [key]: 1, Index: 2 })).toEqual({ Index: 2 });
  });
});

describe('stripUrlishKeys — non-object input', () => {
  it.each([
    ['an array', [{ url: 'x' }]],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'https://x'],
    ['a number', 42],
    ['a Date', new Date(0)],
  ])('returns {} for %s', (_label, input) => {
    expect(stripUrlishKeys(input)).toEqual({});
  });

  it('accepts a null-prototype object', () => {
    const o = Object.assign(Object.create(null) as Record<string, unknown>, { Url: 'x', Size: 1 });
    expect(stripUrlishKeys(o)).toEqual({ Size: 1 });
  });
});

describe('stripUrlishKeys — input handling', () => {
  it('never mutates its input', () => {
    const input = { Url: 'x', Size: 1 };
    stripUrlishKeys(input);
    expect(input).toEqual({ Url: 'x', Size: 1 });
  });

  it('extraWords drops service-specific names as case-insensitive substrings', () => {
    const v = { SessionGuid: 'g', sessionguidv2: 'h', Size: 1 };
    expect(stripUrlishKeys(v, { extraWords: ['sessionGuid'] })).toEqual({ Size: 1 });
  });

  it('extraWords is additive — it cannot re-admit a built-in word', () => {
    expect(stripUrlishKeys({ Url: 'x', Size: 1 }, { extraWords: [] })).toEqual({ Size: 1 });
  });

  it('ignores an empty extraWords entry rather than dropping every key', () => {
    expect(stripUrlishKeys({ Size: 1 }, { extraWords: [''] })).toEqual({ Size: 1 });
  });

  it('is linear on a 200 KB key name', () => {
    const evil = 'sourc'.repeat(40_000);
    const t = performance.now();
    stripUrlishKeys({ [evil]: 1 });
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('is exported from the core barrel', () => {
    expect(root.stripUrlishKeys).toBe(stripUrlishKeys);
  });
});
