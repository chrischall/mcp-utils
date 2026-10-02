import { describe, expect, it } from 'vitest';

import {
  buildUserAgent,
  parseContentDispositionFilename,
  parseRetryAfterMs,
  splitHost,
} from './index.js';

describe('parseRetryAfterMs', () => {
  it('converts a seconds value to milliseconds', () => {
    expect(parseRetryAfterMs('3')).toBe(3000);
  });

  it('caps the honored delay', () => {
    expect(parseRetryAfterMs('9999')).toBe(30_000);
    expect(parseRetryAfterMs('9999', { capMs: 5000 })).toBe(5000);
  });

  it('falls back to the default on missing / junk / negative values', () => {
    expect(parseRetryAfterMs(null)).toBe(2000);
    expect(parseRetryAfterMs(undefined, { defaultMs: 1234 })).toBe(1234);
    expect(parseRetryAfterMs('soon')).toBe(2000);
    expect(parseRetryAfterMs('-1')).toBe(2000);
  });

  it('honors zero as immediate', () => {
    expect(parseRetryAfterMs('0')).toBe(0);
  });
});

describe('splitHost', () => {
  it('splits a subdomained host', () => {
    expect(splitHost('wd5.myworkday.com')).toEqual({
      domain: 'myworkday.com',
      subdomain: 'wd5',
    });
  });

  it('collapses a multi-label subdomain into one prefix', () => {
    expect(splitHost('a.b.example.com')).toEqual({ domain: 'example.com', subdomain: 'a.b' });
  });

  it('returns just the domain for 2-label or bare hosts', () => {
    expect(splitHost('example.com')).toEqual({ domain: 'example.com' });
    expect(splitHost('localhost')).toEqual({ domain: 'localhost' });
  });
});

describe('buildUserAgent', () => {
  it('builds name/version with a contact URL', () => {
    expect(buildUserAgent('musicbrainz-mcp', '1.2.3', 'https://github.com/chrischall/musicbrainz-mcp')).toBe(
      'musicbrainz-mcp/1.2.3 (+https://github.com/chrischall/musicbrainz-mcp)',
    );
  });

  it('omits the contact segment when no URL is given', () => {
    expect(buildUserAgent('foo-mcp', '0.1.0')).toBe('foo-mcp/0.1.0');
  });
});

describe('parseContentDispositionFilename', () => {
  it("decodes the RFC 6266 filename*=UTF-8'' form", () => {
    expect(
      parseContentDispositionFilename(`attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`),
    ).toBe('résumé.pdf');
  });

  it('falls back to the quoted filename= form', () => {
    expect(parseContentDispositionFilename('attachment; filename="report.pdf"')).toBe(
      'report.pdf',
    );
  });

  it('prefers filename* over filename when both are present', () => {
    expect(
      parseContentDispositionFilename(
        `attachment; filename="fallback.bin"; filename*=UTF-8''real%20name.bin`,
      ),
    ).toBe('real name.bin');
  });

  it('returns undefined for a missing header or no filename', () => {
    expect(parseContentDispositionFilename(null)).toBeUndefined();
    expect(parseContentDispositionFilename('inline')).toBeUndefined();
  });

  // The cases ofw-mcp's local parser pinned (tests/client.test.ts) that this
  // one used to fail — chrischall/fleet-audit#1076.
  it("decodes filename*= without the UTF-8'' prefix (ofw)", () => {
    expect(parseContentDispositionFilename('attachment; filename*=Hello%20World.pdf')).toBe('Hello World.pdf');
  });

  it('keeps the raw filename*= token when its percent-encoding is broken and nothing else names the file (ofw)', () => {
    expect(parseContentDispositionFilename("attachment; filename*=UTF-8''bad%ZZname.pdf")).toBe('bad%ZZname.pdf');
  });

  it('prefers a plain filename= over a broken filename*= token', () => {
    expect(parseContentDispositionFilename(`attachment; filename*=UTF-8''bad%ZZ.pdf; filename="good.pdf"`)).toBe(
      'good.pdf',
    );
  });

  it('matches parameter names case-insensitively, as RFC 6266 requires', () => {
    expect(parseContentDispositionFilename('attachment; FILENAME="Up.pdf"')).toBe('Up.pdf');
    expect(parseContentDispositionFilename("attachment; FileName*=utf-8''a%20b.pdf")).toBe('a b.pdf');
  });

  it('matches an unquoted legacy filename (ofw)', () => {
    expect(parseContentDispositionFilename('attachment; filename=legacy.pdf')).toBe('legacy.pdf');
  });

  it('keeps spaces inside a quoted filename (ofw)', () => {
    expect(parseContentDispositionFilename('attachment; filename="legacy file.pdf"')).toBe('legacy file.pdf');
  });

  it('accepts a language tag in filename*=', () => {
    expect(parseContentDispositionFilename("attachment; filename*=UTF-8'en'na%C3%AFve.txt")).toBe('naïve.txt');
  });

  it('decodes an ISO-8859-1 filename*= as Latin-1, not UTF-8', () => {
    expect(parseContentDispositionFilename("attachment; filename*=iso-8859-1''na%EFve.txt")).toBe('naïve.txt');
  });

  it('unescapes a backslash-quoted character inside a quoted filename', () => {
    expect(parseContentDispositionFilename('attachment; filename="say \\"hi\\".txt"')).toBe('say "hi".txt');
  });

  it('strips quotes around a filename*= value some servers add', () => {
    expect(parseContentDispositionFilename(`attachment; filename*="UTF-8''q%20d.pdf"`)).toBe('q d.pdf');
  });

  it('does not read a parameter whose name merely ends in "filename"', () => {
    expect(parseContentDispositionFilename('attachment; xfilename="nope.pdf"')).toBeUndefined();
    expect(parseContentDispositionFilename('attachment; myfilename*=UTF-8\'\'nope.pdf')).toBeUndefined();
  });

  it('reads a header that omits the disposition type', () => {
    expect(parseContentDispositionFilename('filename="bare.pdf"')).toBe('bare.pdf');
    expect(parseContentDispositionFilename("filename*=UTF-8''b%20c.pdf")).toBe('b c.pdf');
    expect(parseContentDispositionFilename('filename="first.pdf"; size=3')).toBe('first.pdf');
  });

  it('falls back to filename= when filename*= decodes to nothing', () => {
    expect(parseContentDispositionFilename(`attachment; filename*=UTF-8''; filename="plain.pdf"`)).toBe('plain.pdf');
  });

  it('skips a valueless parameter before the filename', () => {
    expect(parseContentDispositionFilename('attachment; weird; filename=ok.pdf')).toBe('ok.pdf');
  });

  it('treats an empty filename as no filename', () => {
    expect(parseContentDispositionFilename('attachment; filename=""')).toBeUndefined();
  });

  it('stays linear on a long adversarial header', () => {
    const evil = 'attachment; ' + 'filename*='.repeat(20_000) + ';'.repeat(20_000) + ' filename="' + '\\'.repeat(20_000);
    const t0 = performance.now();
    parseContentDispositionFilename(evil);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it.each([
    ['valueless tokens before a far "="', 'attachment' + '; a'.repeat(100_000) + '; filename=x.pdf'],
    ['bare semicolons', 'attachment' + ';'.repeat(200_000) + 'filename=x.pdf'],
    ['an unterminated quote', 'attachment; filename="' + 'a'.repeat(200_000)],
  ])('stays linear on %s', (_label, header) => {
    const t0 = performance.now();
    parseContentDispositionFilename(header);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe('parseRetryAfterMs fallback contract', () => {
  it('the fallback delayMs is NOT capped — capMs bounds only header-derived delays', () => {
    // An upstream with no Retry-After header must get the caller's configured
    // fallback verbatim, even when it exceeds the header cap.
    expect(parseRetryAfterMs(null, { defaultMs: 60_000, capMs: 5000 })).toBe(60_000);
    expect(parseRetryAfterMs('junk', { defaultMs: 60_000, capMs: 5000 })).toBe(60_000);
  });
});
