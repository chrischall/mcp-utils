import { describe, expect, it } from 'vitest';

import {
  decodeHtmlEntities,
  extractJsonLdBlocks,
  findJsonLdEntity,
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
