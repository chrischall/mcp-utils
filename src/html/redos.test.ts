import { describe, expect, it } from 'vitest';

import {
  extractPlainTextFromHtml,
  findLinksUnderHeading,
  htmlToReadableText,
  parsePropertyTable,
} from './index.js';
import { decodeHtmlEntities } from '../scrape/index.js';

// extractPlainTextFromHtml is the dependency-free renderer infinitecampus uses
// on upstream message bodies (untrusted). The <script>/<style> strip regexes
// backtracked quadratically on withheld terminators, and String.fromCodePoint
// threw on out-of-range numeric entities.

function elapsedMs(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

describe('extractPlainTextFromHtml ReDoS resistance', () => {
  it('is near-linear on many unterminated <script tags', () => {
    const evil = '<script '.repeat(60000);
    const ms = elapsedMs(() => extractPlainTextFromHtml(evil));
    expect(ms).toBeLessThan(1500);
  });

  it('is near-linear on many unterminated <style tags', () => {
    const evil = '<style '.repeat(60000);
    const ms = elapsedMs(() => extractPlainTextFromHtml(evil));
    expect(ms).toBeLessThan(1500);
  });
});

describe('extractPlainTextFromHtml correctness (no regression)', () => {
  it('drops script/style CONTENT and surrounding tags, decodes entities', () => {
    const html =
      '<html><head><style>.a{color:red}</style></head>' +
      '<body>Hello&nbsp;<script>alert(1)</script><b>world</b>!</body></html>';
    expect(extractPlainTextFromHtml(html)).toBe('Hello world !');
  });

  it('handles an unterminated script by dropping the rest (no leak of script text)', () => {
    expect(extractPlainTextFromHtml('keep me <script>secret script tail')).toBe('keep me');
  });

  it('does not throw on an out-of-range numeric entity', () => {
    expect(() => extractPlainTextFromHtml('<p>&#x110000;</p>')).not.toThrow();
    // …and a lone surrogate stays verbatim rather than leaving an unpaired
    // UTF-16 unit in the text (chrischall/fleet-audit#1062).
    expect(extractPlainTextFromHtml('<p>&#xD800;&#56320;&#xE000;</p>')).toBe('&#xD800;&#56320;\uE000');
  });
});

// fleet-audit#1197: the `/<[^>]+>/g` tag strip that ran after the linear
// script/style pass was itself quadratic on a withheld `>` (14 s on 200 KB),
// and node-html-parser's unclosed-tag recovery is superlinear (8000 unclosed
// `<div>` took 23 s). Same 100 ms budget as src/errors/redos.test.ts.
describe('html helpers stay linear on hostile 200 KB bodies (fleet-audit#1197)', () => {
  it.each([
    ['<', '<'.repeat(204_800)],
    ['<a', '<a'.repeat(102_400)],
  ])('extractPlainTextFromHtml is linear on 200 KB of `%s`', (_label, evil) => {
    expect(elapsedMs(() => extractPlainTextFromHtml(evil))).toBeLessThan(100);
  });

  const unclosed: Array<[string, string]> = [
    ['<div>a', '<div>a'.repeat(34_000)],
    ['<span>', '<span>'.repeat(34_000)],
    ['<x>', '<x>'.repeat(68_000)],
    ['<div class="c"><span>t', '<div class="c"><span>t'.repeat(9_000)],
  ];

  it.each(unclosed)('htmlToReadableText is fast on 200 KB of unclosed `%s`', (_label, evil) => {
    expect(elapsedMs(() => htmlToReadableText(evil))).toBeLessThan(100);
  });

  it.each(unclosed)('parsePropertyTable is fast on 200 KB of unclosed `%s`', (_label, evil) => {
    expect(elapsedMs(() => parsePropertyTable(`<h2>Tax</h2>${evil}`, 'Tax'))).toBeLessThan(100);
  });

  it.each(unclosed)('findLinksUnderHeading is fast on 200 KB of unclosed `%s`', (_label, evil) => {
    expect(elapsedMs(() => findLinksUnderHeading(`<h2>Near</h2>${evil}`, 'Near'))).toBeLessThan(100);
  });

  it('still reads text out of a hostile unclosed flood', () => {
    // The repair drops never-closed elements (as node-html-parser's own repair
    // does, by re-parenting their children), so the text survives, unbroken.
    expect(htmlToReadableText('<div>a'.repeat(5_000))).toBe('a'.repeat(5_000));
    expect(parsePropertyTable(`<h2>Tax</h2>${'<div>'.repeat(5_000)}<table><tr><th>Y</th></tr><tr><td>1</td></tr></table>`, 'Tax')).toEqual({
      headers: ['Y'],
      rows: [['Y'], ['1']],
    });
  });

  it('extractPlainTextFromHtml keeps the `<[^>]+>` tag semantics', () => {
    expect(extractPlainTextFromHtml('a <> b')).toBe('a <> b');
    expect(extractPlainTextFromHtml('1 < 2 and 3')).toBe('1 < 2 and 3');
    expect(extractPlainTextFromHtml('x<<a>y')).toBe('x y');
  });
});

// fleet-audit#1300: one entity table. extractPlainTextFromHtml decodes through
// scrape's decodeHtmlEntities, so the two renderers cannot drift.
describe('extractPlainTextFromHtml shares scrape.decodeHtmlEntities (fleet-audit#1300)', () => {
  it.each([
    '&amp;lt;b&amp;gt;',
    '&AMP;&Lt;&nbsp;&quot;&apos;&gt;',
    '&#38;lt; &#x26;amp; &copy; &unknown;',
    '&#65;&#x42;&#999999999999;',
  ])('decodes %s exactly as decodeHtmlEntities does', (input) => {
    expect(extractPlainTextFromHtml(input)).toBe(decodeHtmlEntities(input).replace(/\s+/g, ' ').trim());
  });
});
