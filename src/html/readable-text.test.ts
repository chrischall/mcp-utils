import { describe, it, expect } from 'vitest';
import { htmlToReadableText, extractPlainTextFromHtml } from './index.js';

// fleet-audit#1083: the block-aware DOM extractor hoisted from onthecheap-mcp's
// normalize.ts (its reference tests are ported verbatim below).

describe('htmlToReadableText', () => {
  it('strips markup and collapses whitespace', () => {
    expect(htmlToReadableText('<p>Free  <b>museum</b> day</p>\n<p>Sunday</p>')).toBe('Free museum day Sunday');
  });

  it('decodes entities while stripping', () => {
    expect(htmlToReadableText('<p>Arts &amp; Crafts</p>')).toBe('Arts & Crafts');
  });

  it('truncates to a limit on a word boundary with an ellipsis', () => {
    const text = htmlToReadableText('<p>one two three four five six seven</p>', { limit: 15 });
    expect(text.length).toBeLessThanOrEqual(16);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toMatch(/\s…$/);
    expect(text).toBe('one two three…');
  });

  it('hard-cuts when the last word boundary is too early', () => {
    expect(htmlToReadableText('<p>a supercalifragilistic</p>', { limit: 10 })).toBe('a supercal…');
  });

  it('does not truncate text already within the limit', () => {
    expect(htmlToReadableText('<p>short</p>', { limit: 50 })).toBe('short');
    expect(htmlToReadableText('<p>exactly</p>', { limit: 7 })).toBe('exactly');
  });

  it('keeps adjacent blocks apart instead of gluing their words together', () => {
    expect(
      htmlToReadableText('<p>One</p><p>Two</p><div>Three</div><ul><li>Four</li><li>Five</li></ul>'),
    ).toBe('One Two Three Four Five');
  });

  it('separates table cells, headings and sections', () => {
    expect(
      htmlToReadableText('<h2>Title</h2><table><tr><th>A</th><td>B</td></tr><tr><td>C</td></tr></table><section>D</section>'),
    ).toBe('Title A B C D');
  });

  it('treats a <br> as a word break, so addresses and hours stay readable', () => {
    expect(htmlToReadableText('123 Main St<br>Charlotte, NC<br/>Hours: 9&#8211;5')).toBe(
      '123 Main St Charlotte, NC Hours: 9–5',
    );
  });

  it('drops script, style, JSON-LD, noscript, template, iframe and svg content', () => {
    expect(
      htmlToReadableText(
        '<p>Doors open</p><script>var x=1</script><style>.a{}</style>' +
          '<script type="application/ld+json">{"@type":"Event"}</script><noscript>enable js</noscript>' +
          '<template><p>tmpl</p></template><iframe>frame</iframe><svg><text>icon</text></svg><p>at 10</p>',
      ),
    ).toBe('Doors open at 10');
  });

  it('keeps inline markup joined so a word split across tags stays whole', () => {
    expect(htmlToReadableText('<p><b>F</b>ree <a href="#">entry</a>, <em>all</em>day</p>')).toBe(
      'Free entry, allday',
    );
  });

  it('decodes named entities the lightweight decoders miss', () => {
    expect(htmlToReadableText('<p>9&ndash;5 &hellip; caf&eacute;&nbsp;open</p>')).toBe('9–5 … café open');
  });

  it('drops comments', () => {
    expect(htmlToReadableText('<p>a<!-- secret note -->b</p>')).toBe('ab');
  });

  it('handles a full document', () => {
    expect(
      htmlToReadableText('<!doctype html><html><body><main><p>Hello</p><p>world</p></main></body></html>'),
    ).toBe('Hello world');
  });

  it('returns empty string for empty, null and undefined input', () => {
    expect(htmlToReadableText('')).toBe('');
    expect(htmlToReadableText(null)).toBe('');
    expect(htmlToReadableText(undefined)).toBe('');
    expect(htmlToReadableText('<p>  </p>')).toBe('');
  });

  it('survives very deep nesting without overflowing the stack', () => {
    const depth = 50_000;
    const html = '<div>'.repeat(depth) + 'deep' + '</div>'.repeat(depth);
    expect(htmlToReadableText(html)).toBe('deep');
  });

  it('differs from extractPlainTextFromHtml exactly where the regex version splits words', () => {
    // The dependency-free extractor is unchanged (infinitecampus et al. depend
    // on its output); this documents the semantic gap between the two.
    const html = '<p><b>F</b>ree</p><p>Two</p>';
    expect(extractPlainTextFromHtml(html)).toBe('F ree Two');
    expect(htmlToReadableText(html)).toBe('Free Two');
  });
});
