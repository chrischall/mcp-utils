import { describe, expect, it } from 'vitest';

import {
  decodeHtmlEntities,
  deepCollectArrays,
  deepFindObject,
  extractJsonLdBlocks,
  findJsonLdEntity,
  isCloudflareChallenge,
  ogContent,
  stripHtml,
} from './index.js';

// These guard against catastrophic backtracking (ReDoS) and unguarded
// String.fromCodePoint throws on hostile scraped HTML — the untrusted-input
// path the module's docblock calls out. Each adversarial payload is sized so
// the OLD (vulnerable) implementation blows the time budget while a linear
// implementation finishes in single-digit ms.

function elapsedMs(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

describe('scrape ReDoS resistance', () => {
  it('extractJsonLdBlocks is linear on many unterminated <script type=ld+json tags', () => {
    // No closing `>` and no `</script>` — the withheld terminator that made
    // LD_JSON_RE's two [^>]* backtrack cubically.
    const evil = '<script type="application/ld+json" '.repeat(12000);
    const ms = elapsedMs(() => extractJsonLdBlocks(evil));
    expect(ms).toBeLessThan(1500);
  });

  it('findJsonLdEntity (built on extractJsonLdBlocks) is linear on the same payload', () => {
    const evil = '<script type="application/ld+json" '.repeat(12000);
    const ms = elapsedMs(() => findJsonLdEntity(evil, 'Event'));
    expect(ms).toBeLessThan(1500);
  });

  it('ogContent is linear on many unterminated <meta property tags', () => {
    const evil = '<meta property="og:title" '.repeat(12000);
    const ms = elapsedMs(() => ogContent(evil, 'og:title'));
    expect(ms).toBeLessThan(1500);
  });
});

describe('scrape still works on well-formed input (no regression)', () => {
  it('extractJsonLdBlocks parses every well-formed block, skipping malformed', () => {
    const html = `
      <script type="application/ld+json">{"@type":"A"}</script>
      <script type='application/ld+json'>not json</script>
      <script type="application/ld+json" data-x="1">{"@type":"Event","name":"Show"}</script>`;
    const blocks = extractJsonLdBlocks(html) as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect((findJsonLdEntity(html, 'Event') as Record<string, unknown>).name).toBe('Show');
  });

  it('ogContent still reads both attribute orders and decodes entities', () => {
    expect(ogContent('<meta property="og:title" content="A &amp; B"/>', 'og:title')).toBe('A & B');
    expect(ogContent('<meta content="World" property="og:site_name">', 'og:site_name')).toBe(
      'World',
    );
    expect(ogContent('<meta property="og:title" content="x">', 'og:image')).toBeUndefined();
  });
});

describe('HTML entity decode does not throw on out-of-range code points', () => {
  it('decodeHtmlEntities passes through an out-of-range numeric entity instead of throwing', () => {
    expect(() => decodeHtmlEntities('&#999999999999;')).not.toThrow();
    expect(() => decodeHtmlEntities('&#x110000;')).not.toThrow();
    // The invalid reference is left as-is (best-effort), valid ones still decode.
    expect(decodeHtmlEntities('&#65;&#999999999999;&#66;')).toBe('A&#999999999999;B');
  });

  it('stripHtml / ogContent survive an out-of-range entity in hostile input', () => {
    expect(() => stripHtml('<p>&#x110000;</p>')).not.toThrow();
    expect(() =>
      ogContent('<meta property="og:title" content="&#999999999999;">', 'og:title'),
    ).not.toThrow();
  });
});

// fleet-audit#1197: the exported predicates fleet repos run on WHOLE upstream
// bodies. `<title[^>]*>` and `<[^>]+>` re-scan the rest of the body from every
// opener when the `>` is withheld (5-14 s on 200 KB). Same 100 ms budget as
// src/errors/redos.test.ts.
describe('whole-body scrape predicates are linear (fleet-audit#1197)', () => {
  it.each([
    ['<title (no `>`)', '<title'.repeat(34_952)],
    ['<title … one `>` at the end', `${'<title'.repeat(34_952)}>`],
    ['<title> without the marker', '<title>x'.repeat(25_000)],
    ['<TITLE (upper case)', '<TITLE '.repeat(29_000)],
  ])('isCloudflareChallenge is linear on 200 KB of `%s`', (_label, evil) => {
    expect(elapsedMs(() => isCloudflareChallenge(evil))).toBeLessThan(100);
  });

  it.each([
    ['<', '<'.repeat(204_800)],
    ['<a', '<a'.repeat(102_400)],
    ['< … one `>` at the end', `${'<'.repeat(204_800)}>`],
  ])('stripHtml is linear on 200 KB of `%s`', (_label, evil) => {
    expect(elapsedMs(() => stripHtml(evil))).toBeLessThan(100);
  });

  it('isCloudflareChallenge still matches only the definitive markers', () => {
    expect(isCloudflareChallenge('<html><head><title>Just a moment...</title>')).toBe(true);
    expect(isCloudflareChallenge('<TITLE lang="en">\n  just A MOMENT</TITLE>')).toBe(true);
    expect(isCloudflareChallenge('<title>Home</title><title>Just a moment</title>')).toBe(true);
    expect(isCloudflareChallenge('<titles x>Just a moment')).toBe(true); // `[^>]*` semantics kept
    expect(isCloudflareChallenge('<script>window._cf_chl_opt={}</script>')).toBe(true);
    expect(isCloudflareChallenge('<title>Welcome</title> Just a moment')).toBe(false);
    expect(isCloudflareChallenge('<title Just a moment')).toBe(false);
    expect(isCloudflareChallenge('<p>Just a moment</p>')).toBe(false);
  });

  it('stripHtml keeps the `<[^>]+>` tag semantics', () => {
    expect(stripHtml('<p>Hello</p><b>world</b>')).toBe('Hello world');
    expect(stripHtml('a <> b')).toBe('a <> b'); // `<>` is not a tag
    expect(stripHtml('1 < 2 and 3')).toBe('1 < 2 and 3'); // no `>`: left alone
    expect(stripHtml('x<<a>y')).toBe('x y'); // `[^>]` includes `<`
    expect(stripHtml('a<b>c<d')).toBe('a c<d');
    expect(stripHtml('&lt;b&gt;')).toBe('<b>'); // decoded after the strip
  });
});

// fleet-audit#1296: JSON.parse is iterative, so a hostile SSR blob nested far
// deeper than the call stack parses fine; the walkers must not then throw
// RangeError on it.
describe('deep walkers survive hostile nesting depth (fleet-audit#1296)', () => {
  const deepArrays = JSON.parse(`${'['.repeat(50_000)}${']'.repeat(50_000)}`) as unknown;
  const deepObjects = JSON.parse(`${'{"a":'.repeat(50_000)}{"hit":1}${'}'.repeat(50_000)}`) as unknown;

  it('deepFindObject walks 50k levels without a stack overflow', () => {
    expect(deepFindObject(deepArrays, () => false)).toBeNull();
    expect(deepFindObject(deepObjects, (o) => o.hit === 1)).toEqual({ hit: 1 });
  });

  it('deepCollectArrays walks 50k levels without a stack overflow', () => {
    expect(() => deepCollectArrays(deepArrays, () => false)).not.toThrow();
    expect(deepCollectArrays(deepArrays, (first) => Array.isArray(first))).toHaveLength(49_999);
  });

  it('keeps depth-first, document-order results', () => {
    const root = { a: [{ id: 1 }, { id: 2 }], b: { c: [{ id: 3 }], d: { id: 4, x: [{ id: 5 }] } } };
    expect(deepCollectArrays(root, (f) => typeof f === 'object' && f !== null && 'id' in f)).toEqual([
      root.a,
      root.b.c,
      root.b.d.x,
    ]);
    expect(deepFindObject(root, (o) => o.id === 2)).toEqual({ id: 2 });
    expect(deepFindObject(root, (o) => typeof o.id === 'number' && o.id > 3)).toEqual(root.b.d);
    expect(deepFindObject([[{ id: 9 }], { id: 10 }], (o) => 'id' in o)).toEqual({ id: 9 });
  });
});
