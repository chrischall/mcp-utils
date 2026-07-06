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
});

describe('parseRetryAfterMs fallback contract (PR #66 follow-up)', () => {
  it('the fallback delayMs is NOT capped — capMs bounds only header-derived delays', () => {
    // An upstream with no Retry-After header must get the caller's configured
    // fallback verbatim, even when it exceeds the header cap.
    expect(parseRetryAfterMs(null, { defaultMs: 60_000, capMs: 5000 })).toBe(60_000);
    expect(parseRetryAfterMs('junk', { defaultMs: 60_000, capMs: 5000 })).toBe(60_000);
  });
});
