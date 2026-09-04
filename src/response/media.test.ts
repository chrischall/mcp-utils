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

  it('drops the SUFFIXED media keys every Google Workspace API uses', () => {
    // Google names a media reference `<noun>Link` / `<noun>Uri` / `<noun>Url`
    // rather than the bare noun, so the anchored key rule matched none of them.
    // Measured on a real `gog drive ls` listing of 25 rows: thumbnailLink alone
    // was 4,973 bytes of 15,698 — 32% of the payload, and this helper removed
    // ZERO of it. Nor is the URL rule a fallback there: Google's media URLs are
    // extension-less signed URLs, so MEDIA_URL misses them too.
    const file = {
      id: 'f1',
      name: 'Budget.xlsx',
      thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/AAbc123=s220',
      iconLink: 'https://drive-thirdparty.googleusercontent.com/16/type/application/pdf',
      iconUri: 'https://ssl.gstatic.com/calendar/images/i.png',
      photoUrl: 'https://lh3.googleusercontent.com/a/AAcHT=s100',
    };
    expect(stripMediaUrls(file)).toEqual({ id: 'f1', name: 'Budget.xlsx' });
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

  it('keeps a page whose PATH merely contains the word avatar', () => {
    // The rule is an image extension ending the path, and nothing looser.
    // `…/users/avatar-collection` and `…/v1/avatar/settings` are pages, and
    // earlier drafts stripped both while removing zero additional bytes from
    // the payload that motivated this helper.
    const pages = {
      a: 'https://example.com/users/avatar-collection',
      b: 'https://api.example.com/v1/avatar/settings',
      c: 'https://example.com/photos',
    };
    expect(stripMediaUrls(pages)).toEqual(pages);
  });

  it('keeps a signed URL whose QUERY happens to contain an image extension', () => {
    // Splitwise's receipt link. That one is content a caller asked for.
    const v = { receipt: 'https://www.splitwise.com/api/v4.0/expenses/466/receipt?cachebust=29f.jpeg&size=large' };
    expect(stripMediaUrls(v)).toEqual(v);
  });

  it('still strips an avatar under a media KEY however the URL is shaped', () => {
    // The key check does the work the loose URL clauses were reaching for.
    expect(stripMediaUrls({ avatar: 'https://cdn.example.com/u/9', id: 1 })).toEqual({ id: 1 });
  });

  it('keeps a key that merely CONTAINS a media noun rather than starting with one', () => {
    // The anchor stays at the start, so a predicate about a picture survives
    // while the picture itself goes. `hasThumbnail: false` is a fact about the
    // file — a caller filtering on it would otherwise see the key vanish and
    // read that as "not reported". Drive emits it on every row.
    const v = {
      hasThumbnail: false,
      isImage: true,
      profileIconVisible: true,
    };
    expect(stripMediaUrls(v)).toEqual(v);
  });

  it('keeps a media noun followed by anything that is not a URL suffix', () => {
    // thumbnailWidth is a NUMBER, imageMediaMetadata is EXIF. Only the three
    // reference suffixes are added; everything else stays as it was.
    const v = {
      thumbnailWidth: 220,
      imageMediaMetadata: { width: 4032, height: 3024 },
      photoCount: 12,
    };
    expect(stripMediaUrls(v)).toEqual(v);
  });

  it('keeps webViewLink and other page links, whose noun is not media', () => {
    // Drive's own `webViewLink` is the link a caller acts on, and it sits in the
    // same object as thumbnailLink. Getting this wrong would empty the response
    // of the one URL that matters.
    const v = {
      webViewLink: 'https://docs.google.com/spreadsheets/d/abc/edit',
      webContentLink: 'https://drive.google.com/uc?id=abc&export=download',
      htmlLink: 'https://www.google.com/calendar/event?eid=xyz',
    };
    expect(stripMediaUrls(v)).toEqual(v);
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
