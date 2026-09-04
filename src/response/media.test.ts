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

describe('plurals of the suffixed keys', () => {
  it('strips imageUrls / photoUrls / avatarUrls, not just their singulars', () => {
    // Not hypothetical: imageUrls and photoUrls appear 22 times across groupon-mcp and
    // redfin-mcp. A rule that catches `imageUrl` and misses `imageUrls` is the
    // kind of half-cover that reads as working.
    const v = { id: 1, imageUrls: ['https://cdn/a'], photoUrls: { small: 'x' }, avatarUrls: [], thumbnailLinks: ['y'] };
    expect(stripMediaUrls(v)).toEqual({ id: 1 });
  });

  it('still keeps the near-miss keys the plural could have swept up', () => {
    const v = { photoCount: 3, thumbnailWidth: 220, urls: ['https://example.com/a'], links: [] };
    expect(stripMediaUrls(v)).toEqual(v);
  });
});

describe('snake_case and kebab-case media keys', () => {
  /**
   * The pattern was camelCase-only: `photoUrl` matched, `photo_url` did not,
   * because the suffix group ran directly against the noun with no separator.
   * ~513 such keys exist across the fleet — `image_url` alone 244 times.
   *
   * The consequence was not "some bytes survive". It was INCONSISTENCY, since
   * `MEDIA_URL` then judged each value on its own. canvas-parent-mcp saw it
   * live in one response: Canvas's DEFAULT avatar ends `.png` and was dropped,
   * an UPLOADED one is an extension-less thumbnail id and survived — so one
   * participant in an array kept their avatar and another lost theirs.
   */
  it('strips the snake_case forms that were previously missed entirely', () => {
    const v = {
      id: 1,
      image_url: 'https://cdn/a', photo_url: 'https://cdn/b', avatar_url: 'https://cdn/c',
      thumbnail_url: 'https://cdn/d', profile_picture_urls: ['x'], image_links: ['y'],
      icon_url: 'https://cdn/e', logo_url: 'https://cdn/f', image_src: 'https://cdn/g',
    };
    expect(stripMediaUrls(v)).toEqual({ id: 1 });
  });

  it('strips a bounded qualifier prefix, and a media noun in that slot', () => {
    // `primary_photo_url` (compass, redfin) and `avatar_image_url` (canvas).
    const v = { id: 1, primary_photo_url: 'x', primary_thumbnail_url: 'y', avatar_image_url: 'z', rendered_image_url: 'w' };
    expect(stripMediaUrls(v)).toEqual({ id: 1 });
  });

  it('strips kebab-case too', () => {
    expect(stripMediaUrls({ id: 1, 'hero-image-url': 'x', 'photo-url': 'y' })).toEqual({ id: 1 });
  });

  it('does NOT strip an unqualified word that merely starts with a listed qualifier', () => {
    // The qualifier list is closed AND still requires a media noun after it.
    // These are the snake_case traps the widening could plausibly have broken.
    const keep = {
      primary_key: 1, main_content: 2, cover_letter: 3, default_currency: 'USD',
      full_name: 'A', original_price: 9, medium_name: 'm', profile_id: 7,
      photo_count: 3, has_photo: true, photo_index: 0, image_media_metadata: {}, logo_text: 'x',
    };
    expect(stripMediaUrls(keep)).toEqual(keep);
  });

  it('treats a qualifier the same in camelCase and snake_case', () => {
    // Removing the redundant `cover_photo`/`cover_image`/`tall_avatar` entries
    // exposed an asymmetry they had been masking: with the separator REQUIRED,
    // `cover_photo` was stripped and `coverPhoto` was kept — same field, same
    // meaning, different answer decided by an API's casing convention. That is
    // the bug #197 was about, one level up.
    const v = {
      id: 1,
      cover_photo: 'a', coverPhoto: 'b', cover_image: 'c', coverImage: 'd',
      tall_avatar: 'e', tallAvatar: 'f', coverPhotoUrl: 'g', cover_photo_url: 'h',
      primaryPhotoUrl: 'i', primary_photo_url: 'j', avatarImageUrl: 'k', avatar_image_url: 'l',
    };
    expect(stripMediaUrls(v)).toEqual({ id: 1 });
  });

  it('does not let the optional separator swallow ordinary words', () => {
    // The qualifier list is closed and a media noun must still follow it, which
    // is what keeps these safe once the separator is optional.
    const keep = {
      coverage: 1, mainframe: 2, profileId: 3, coverNote: 4, mainAccount: 5,
      imagemap: 6, photographer: 7, iconic: 8, bannerless: 9, logout: 10, profiler: 11,
    };
    expect(stripMediaUrls(keep)).toEqual(keep);
  });

  it('still keeps everything #192 promised would survive', () => {
    const keep = { hasThumbnail: false, thumbnailWidth: 220, imageMediaMetadata: {}, webViewLink: 'https://docs.google.com/d/1/edit' };
    expect(stripMediaUrls(keep)).toEqual(keep);
  });
});

describe('the `drop` escape hatch', () => {
  it('drops an extra key a service names in its own way', () => {
    // The symmetric half of `keep`. It exists so a repo does not need a LIBRARY
    // RELEASE to strip its own noise — which is what Google Workspace's
    // thumbnailLink/iconUri naming cost the first time.
    const v = { id: 1, heroAsset: 'https://cdn/x', blurHash: 'LEHV6n' };
    expect(stripMediaUrls(v, { drop: ['heroAsset', /^blur/i] })).toEqual({ id: 1 });
  });

  it('matches a string rule case-insensitively and a RegExp as given', () => {
    expect(stripMediaUrls({ HeroAsset: 1, keep: 2 }, { drop: ['heroasset'] })).toEqual({ keep: 2 });
    expect(stripMediaUrls({ heroAsset: 1, HeroAsset: 2 }, { drop: [/^heroAsset$/] })).toEqual({ HeroAsset: 2 });
  });

  it('recurses, so a nested occurrence goes too', () => {
    expect(stripMediaUrls({ a: { b: { heroAsset: 1, n: 2 } } }, { drop: ['heroAsset'] })).toEqual({ a: { b: { n: 2 } } });
  });

  it('keep accepts a RegExp, symmetrically with drop', () => {
    // The gap this closes. A repo preserving several CONSTRUCTED media fields
    // that share a prefix had to enumerate every one, while the opposite intent
    // could already be a pattern — redfin-mcp keeps `image_url` +
    // `thumbnail_url`, compass-mcp `primary_photo_url` + `primary_thumbnail_url`.
    const v = { id: 1, primary_photo_url: 'a', primary_thumbnail_url: 'b', avatar_url: 'c' };
    expect(stripMediaUrls(v, { keep: [/^primary_/] })).toEqual({
      id: 1, primary_photo_url: 'a', primary_thumbnail_url: 'b',
    });
  });

  it('a keep RegExp is immune to its own flags, like drop', () => {
    // `test()` on a /g pattern advances lastIndex, so one rule object tested
    // across a sequence of keys skips the next key whose length falls inside
    // the advanced index. It fails toward DELETING a kept field here, which is
    // the worse direction — hence the same copy-per-call fix #196 gave `drop`.
    const v = { keepA: 'x', keepB: 'y', keepC: 'z', avatar: 'gone' };
    expect(stripMediaUrls(v, { keep: [/^keep/g] })).toEqual({ keepA: 'x', keepB: 'y', keepC: 'z' });
  });

  it('does not mutate a caller-supplied keep RegExp', () => {
    const rule = /^keep/g;
    rule.lastIndex = 3;
    stripMediaUrls({ keepA: 1, keepB: 2 }, { keep: [rule] });
    expect(rule.lastIndex).toBe(3);
  });

  it('keep wins over drop, so an explicit keep is never overridden', () => {
    expect(stripMediaUrls({ avatar: 'x', id: 1 }, { keep: ['avatar'], drop: ['avatar'] })).toEqual({ avatar: 'x', id: 1 });
  });
});

describe('arrays of bare image URLs', () => {
  /**
   * The one place this helper knowingly leaves bytes on the table, and it is a
   * decision rather than an oversight.
   *
   * Removing a KEY is visible — the field is gone and a reader can see it.
   * Removing ELEMENTS is invisible: the array is merely shorter, and a caller
   * reading `floorplan_urls.length` to say "this listing has 4 floor plans"
   * would be quietly wrong. Same class of harm as the dropped-nulls rule this
   * helper also refuses.
   *
   * Found in homes-mcp, whose `floorplan_urls` holds an array of `.jpg` links
   * under a key no media rule matches. `drop` is the answer there.
   */
  it('keeps an array of image URLs under a non-media key', () => {
    const v = { id: 1, floorplan_urls: ['https://cdn/a.jpg', 'https://cdn/b.png'] };
    expect(stripMediaUrls(v)).toEqual(v);
  });

  it('but the KEY rule still removes an array under a media-named key', () => {
    expect(stripMediaUrls({ id: 1, photos: ['https://cdn/a.jpg'] })).toEqual({ id: 1 });
  });

  it('and `drop` removes the key outright, which is the intended fix', () => {
    const v = { id: 1, floorplan_urls: ['https://cdn/a.jpg'] };
    expect(stripMediaUrls(v, { drop: ['floorplan_urls'] })).toEqual({ id: 1 });
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

  // A g/y-flagged RegExp is STATEFUL: test() advances lastIndex on a match, so
  // the same rule object silently skips the next key whose length falls inside
  // the advanced index. It fails OPEN — the key survives — and the result
  // depends on key ORDER, so it reads as "the rule just didn't match" rather
  // than as a bug. `drop` takes caller-supplied regexes and nothing in the type
  // forbids a /g, which is a natural thing to write.
  it('honours a drop rule whatever flags the caller put on it', () => {
    for (const rule of [/^blur/g, /^blur/gi, /^blur/y, /^blur/]) {
      expect(stripMediaUrls({ blurA: 1, blurB: 2, blurC: 3, keepMe: 4 }, { drop: [rule] }))
        .toEqual({ keepMe: 4 });
    }
  });

  // The drop array is documented as something a repo hoists as a shared
  // constant, which is exactly when cross-CALL lastIndex leakage would bite.
  it('does not let one call leak regex state into the next', () => {
    const shared = [/^blur/g];
    const row = { blurA: 1, keepMe: 2 };
    expect(stripMediaUrls(row, { drop: shared })).toEqual({ keepMe: 2 });
    expect(stripMediaUrls(row, { drop: shared })).toEqual({ keepMe: 2 });
  });

  // "never mutates its input" is a promise this helper already makes about the
  // payload; a caller's RegExp is input too.
  it('never mutates a caller-supplied regex', () => {
    const rule = /^blur/g;
    rule.lastIndex = 3;
    stripMediaUrls({ blurA: 1 }, { drop: [rule] });
    expect(rule.lastIndex).toBe(3);
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
