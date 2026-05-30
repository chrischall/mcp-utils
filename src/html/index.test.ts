import { describe, it, expect } from 'vitest';
import { parse } from 'node-html-parser';
import {
  parsePropertyTable,
  findLinksUnderHeading,
  extractJsonFromHtml,
  extractPlainTextFromHtml,
  urlToPath,
  locationToSlug,
  buildIdExtractor,
} from './index.js';

describe('parsePropertyTable', () => {
  it('returns header cells from <thead> and tbody rows', () => {
    const html = `
      <h2>Tax History</h2>
      <table>
        <thead><tr><th>Year</th><th>Property Tax</th><th>Assessment</th></tr></thead>
        <tbody>
          <tr><th scope="row">2023</th><td>$1,200</td><td>$300,000</td></tr>
          <tr><th scope="row">2022</th><td>$1,100</td><td>$280,000</td></tr>
        </tbody>
      </table>`;
    const result = parsePropertyTable(html, 'Tax History');
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(['Year', 'Property Tax', 'Assessment']);
    expect(result!.rows).toEqual([
      ['2023', '$1,200', '$300,000'],
      ['2022', '$1,100', '$280,000'],
    ]);
  });

  it('matches the heading case-insensitively and as a substring', () => {
    const html = `
      <h3>Property History (recent)</h3>
      <table>
        <thead><tr><th>Date</th><th>Event</th></tr></thead>
        <tbody><tr><td>04/30/2026</td><td>Listed</td></tr></tbody>
      </table>`;
    const result = parsePropertyTable(html, 'property history');
    expect(result?.headers).toEqual(['Date', 'Event']);
    expect(result?.rows).toEqual([['04/30/2026', 'Listed']]);
  });

  it('collects leading <th scope="row"> cells so columns do not shift', () => {
    // The leading data cell is a <th>, not a <td>; dropping it would corrupt
    // every parsed record. Header cells stay scoped to <thead>.
    const html = `
      <h2>Mortgage History</h2>
      <table>
        <thead><tr><th>Date</th><th>Amount</th></tr></thead>
        <tbody>
          <tr><th scope="row">01/15/2020</th><td>$250,000</td></tr>
        </tbody>
      </table>`;
    const result = parsePropertyTable(html, 'Mortgage History');
    expect(result!.headers).toEqual(['Date', 'Amount']);
    expect(result!.rows).toEqual([['01/15/2020', '$250,000']]);
  });

  it('stops at the next heading and finds a nested table in a wrapper', () => {
    const html = `
      <h2>Schools</h2>
      <div><table><thead><tr><th>Name</th></tr></thead>
        <tbody><tr><td>Lincoln Elementary</td></tr></tbody></table></div>
      <h2>Tax History</h2>
      <table><thead><tr><th>Year</th></tr></thead>
        <tbody><tr><td>2023</td></tr></tbody></table>`;
    expect(parsePropertyTable(html, 'Schools')!.headers).toEqual(['Name']);
    expect(parsePropertyTable(html, 'Tax History')!.headers).toEqual(['Year']);
  });

  it('falls back to a table inside a section wrapper around the heading', () => {
    const html = `
      <section>
        <h3>Listing Details</h3>
        <table><thead><tr><th>Field</th></tr></thead>
          <tbody><tr><td>Value</td></tr></tbody></table>
      </section>`;
    const result = parsePropertyTable(html, 'Listing Details');
    expect(result!.headers).toEqual(['Field']);
  });

  it('collapses internal whitespace in cell text', () => {
    const html = `
      <h2>Data</h2>
      <table><thead><tr><th>  Sale\n  Price </th></tr></thead>
        <tbody><tr><td>  $1,000,000\t </td></tr></tbody></table>`;
    const result = parsePropertyTable(html, 'Data');
    expect(result!.headers).toEqual(['Sale Price']);
    expect(result!.rows).toEqual([['$1,000,000']]);
  });

  it('falls back to all <th> when no <thead> is present', () => {
    const html = `
      <h2>Flat</h2>
      <table><tr><th>A</th><th>B</th></tr></table>`;
    const result = parsePropertyTable(html, 'Flat');
    expect(result!.headers).toEqual(['A', 'B']);
  });

  it('returns null when the heading is not found', () => {
    expect(parsePropertyTable('<h2>Other</h2>', 'Tax History')).toBeNull();
  });

  it('returns null when the heading exists but no table follows', () => {
    expect(parsePropertyTable('<h2>Tax History</h2><p>none</p>', 'Tax History')).toBeNull();
  });
});

describe('findLinksUnderHeading', () => {
  it('returns anchors following the heading up to the next heading', () => {
    const html = `
      <h2>Homes for Sale</h2>
      <ul>
        <li><a href="/a/">A</a></li>
        <li><a href="/b/">B</a></li>
      </ul>
      <h2>Other</h2>
      <a href="/c/">C</a>`;
    const root = parse(html);
    const links = findLinksUnderHeading(root, 'Homes for Sale');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/a/', '/b/']);
  });

  it('matches case-insensitively as a substring', () => {
    const html = `<h3>Nearby Homes for Sale</h3><a href="/x/">X</a><h3>End</h3>`;
    const root = parse(html);
    const links = findLinksUnderHeading(root, 'homes for sale');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/x/']);
  });

  it('also collects a direct sibling <a> (not just nested)', () => {
    const html = `<h2>Links</h2><a href="/direct/">d</a><h2>Stop</h2>`;
    const root = parse(html);
    const links = findLinksUnderHeading(root, 'Links');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/direct/']);
  });

  it('accepts a raw HTML string as well as a parsed root', () => {
    const links = findLinksUnderHeading('<h2>L</h2><a href="/y/">y</a>', 'L');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/y/']);
  });

  it('returns an empty array when the heading is absent', () => {
    expect(findLinksUnderHeading('<h2>Other</h2>', 'Missing')).toEqual([]);
  });
});

describe('extractJsonFromHtml', () => {
  it('extracts a window.__INITIAL_STATE__ assignment', () => {
    const html = `<script>window.__INITIAL_STATE__ = {"a":1,"b":{"c":2}};</script>`;
    expect(extractJsonFromHtml(html)).toEqual({ a: 1, b: { c: 2 } });
  });

  it('extracts a "__INITIAL_STATE__": JSON key form', () => {
    const html = `<script>{"foo":"bar","__INITIAL_STATE__":{"x":[1,2,3]},"baz":9}</script>`;
    expect(extractJsonFromHtml(html)).toEqual({ x: [1, 2, 3] });
  });

  it('walks braces correctly past strings containing braces and quotes', () => {
    const html = `window.__INITIAL_STATE__ = {"s":"a } \\" { b","n":{"deep":true}};`;
    expect(extractJsonFromHtml(html)).toEqual({
      s: 'a } " { b',
      n: { deep: true },
    });
  });

  it('handles escaped backslashes before a quote', () => {
    const html = `window.__INITIAL_STATE__ = {"path":"C:\\\\dir\\\\","ok":true};`;
    expect(extractJsonFromHtml(html)).toEqual({ path: 'C:\\dir\\', ok: true });
  });

  it('returns null when no marker is present', () => {
    expect(extractJsonFromHtml('<html><body>nope</body></html>')).toBeNull();
  });

  it('returns null when braces are unbalanced', () => {
    const html = `window.__INITIAL_STATE__ = {"a":1`;
    expect(extractJsonFromHtml(html)).toBeNull();
  });

  it('returns null when the captured slice is not valid JSON', () => {
    const html = `window.__INITIAL_STATE__ = {a:1, b:2}`;
    expect(extractJsonFromHtml(html)).toBeNull();
  });

  it('accepts a caller-supplied marker', () => {
    const html = `<script>window.__APOLLO_STATE__ = {"q":42};</script>`;
    expect(extractJsonFromHtml(html, '__APOLLO_STATE__')).toEqual({ q: 42 });
  });
});

describe('extractPlainTextFromHtml', () => {
  it('strips script and style blocks and remaining tags', () => {
    const html = `
      <html><head><style>.x{color:red}</style></head>
      <body><script>var x = 1 < 2;</script>
      <p>Hello <b>world</b></p></body></html>`;
    const text = extractPlainTextFromHtml(html);
    expect(text).toBe('Hello world');
  });

  it('decodes common HTML entities', () => {
    const html = `<p>Tom &amp; Jerry &lt;3 &quot;quoted&quot; it&#39;s &nbsp;fine</p>`;
    expect(extractPlainTextFromHtml(html)).toBe(`Tom & Jerry <3 "quoted" it's fine`);
  });

  it('decodes numeric and hex character references', () => {
    const html = `<p>&#65;&#x42;&#67;</p>`;
    expect(extractPlainTextFromHtml(html)).toBe('ABC');
  });

  it('collapses whitespace runs and trims', () => {
    const html = `  <div>  a\n\n   b\t c  </div>  `;
    expect(extractPlainTextFromHtml(html)).toBe('a b c');
  });

  it('does not leak script contents that look like text', () => {
    const html = `<script>document.write("SECRET")</script><p>ok</p>`;
    const text = extractPlainTextFromHtml(html);
    expect(text).toBe('ok');
    expect(text).not.toContain('SECRET');
  });

  it('returns empty string for empty input', () => {
    expect(extractPlainTextFromHtml('')).toBe('');
  });
});

describe('urlToPath', () => {
  it('reduces an absolute URL to pathname + search', () => {
    expect(urlToPath('https://www.zillow.com/homedetails/foo/7_zpid/?x=1')).toBe(
      '/homedetails/foo/7_zpid/?x=1',
    );
  });

  it('keeps any host but only returns the path', () => {
    expect(urlToPath('http://example.com/a/b')).toBe('/a/b');
  });

  it('passes a leading-slash path through unchanged', () => {
    expect(urlToPath('/already/a/path/?q=2')).toBe('/already/a/path/?q=2');
  });

  it('coerces a bare segment to a leading-slash path', () => {
    expect(urlToPath('homedetails/7_zpid/')).toBe('/homedetails/7_zpid/');
  });

  it('never throws on malformed input', () => {
    expect(urlToPath('::::not a url::::')).toBe('/::::not a url::::');
  });
});

describe('locationToSlug', () => {
  it('slugifies "City, ST" to city-st', () => {
    expect(locationToSlug('Brooklyn, NY')).toBe('brooklyn-ny');
    expect(locationToSlug('New York, NY')).toBe('new-york-ny');
  });

  it('passes a bare ZIP through unchanged', () => {
    expect(locationToSlug('94110')).toBe('94110');
  });

  it('strips diacritics', () => {
    expect(locationToSlug('Cañon City, CO')).toBe('canon-city-co');
  });

  it('collapses punctuation runs and trims separators', () => {
    expect(locationToSlug('  --Park   Slope!!--  ')).toBe('park-slope');
  });
});

describe('buildIdExtractor', () => {
  it('returns the first capture group from a matching URL', () => {
    const extract = buildIdExtractor(/\/home\/(\d+)(?:[/?#]|$)/);
    expect(extract('/FL/Miami/123-Main-St-33101/home/45678')).toBe('45678');
    expect(extract('https://www.redfin.com/x/home/9/')).toBe('9');
  });

  it('returns undefined when the pattern does not match', () => {
    const extract = buildIdExtractor(/\/home\/(\d+)/);
    expect(extract('/no/match/here')).toBeUndefined();
  });

  it('returns undefined for empty or nullish input', () => {
    const extract = buildIdExtractor(/(\d+)/);
    expect(extract('')).toBeUndefined();
    expect(extract(undefined)).toBeUndefined();
  });

  it('extracts an opaque _pid token', () => {
    const extract = buildIdExtractor(/\/([A-Za-z0-9]+)_pid\/?$/);
    expect(extract('/listing/slug/abc123XYZ_pid/')).toBe('abc123XYZ');
    expect(extract('/listing/slug/sha_lid/')).toBeUndefined();
  });

  it('is not corrupted by regex lastIndex when the source is global', () => {
    // A global regex carries lastIndex state; a naive .exec reuse would skip
    // matches on alternating calls. The extractor must be stateless.
    const extract = buildIdExtractor(/(\d+)/g);
    expect(extract('id-7')).toBe('7');
    expect(extract('id-7')).toBe('7');
    expect(extract('id-7')).toBe('7');
  });

  it('falls back to the whole match when there is no capture group', () => {
    const extract = buildIdExtractor(/\d+/);
    expect(extract('abc-99-def')).toBe('99');
  });
});
