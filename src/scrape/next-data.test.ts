import { describe, expect, it } from 'vitest';

import { NEXT_DATA_MAX_CHARS, extractNextData, extractNextDataText } from './index.js';

const blob = { props: { pageProps: { zpid: 42, gdpClientCache: '{"a":1}' } }, page: '/homedetails', buildId: 'b1' };
const page = (attrs: string, body: string) =>
  `<!doctype html><html><head><script src="/x.js"></script></head><body>` +
  `<div id="__next"></div><script ${attrs}>${body}</script><script>var after = 1;</script></body></html>`;

describe('extractNextData', () => {
  it('parses the canonical Next.js tag', () => {
    expect(extractNextData(page('id="__NEXT_DATA__" type="application/json"', JSON.stringify(blob)))).toEqual(blob);
  });

  it('accepts attribute order, single quotes, unquoted values, extra attrs and case-insensitive names', () => {
    const json = JSON.stringify(blob);
    for (const attrs of [
      `type="application/json" id="__NEXT_DATA__"`,
      `id='__NEXT_DATA__' type='application/json'`,
      `id=__NEXT_DATA__ type=application/json`,
      `crossorigin="anonymous" ID="__NEXT_DATA__" nonce="abc"`,
      `id = "__NEXT_DATA__"`,
    ]) {
      expect(extractNextData(page(attrs, json))).toEqual(blob);
    }
  });

  it('trims whitespace around the JSON body', () => {
    expect(extractNextData(page('id="__NEXT_DATA__"', `\n  ${JSON.stringify(blob)}  \n`))).toEqual(blob);
  });

  it('selects props or pageProps', () => {
    const html = page('id="__NEXT_DATA__"', JSON.stringify(blob));
    expect(extractNextData(html, { select: 'props' })).toEqual(blob.props);
    expect(extractNextData(html, { select: 'pageProps' })).toEqual(blob.props.pageProps);
    expect(extractNextData(html, { select: 'all' })).toEqual(blob);
  });

  it('returns undefined when the selected level is missing or not an object', () => {
    expect(extractNextData(page('id="__NEXT_DATA__"', '{"props":{}}'), { select: 'pageProps' })).toBeUndefined();
    expect(extractNextData(page('id="__NEXT_DATA__"', '{"page":"/"}'), { select: 'props' })).toBeUndefined();
    expect(extractNextData(page('id="__NEXT_DATA__"', '{"props":{"pageProps":[1]}}'), { select: 'pageProps' })).toBeUndefined();
    expect(extractNextData(page('id="__NEXT_DATA__"', '{"props":{"pageProps":null}}'), { select: 'pageProps' })).toBeUndefined();
  });

  it('honours a custom script id (other __NEXT_DATA__-style tags)', () => {
    const html = page('id="__NEXT_DATA__"', '{"which":"next"}') + page('id="__APP_DATA__" type="application/json"', '{"which":"app"}');
    expect(extractNextData(html, { id: '__APP_DATA__' })).toEqual({ which: 'app' });
    expect(extractNextData(html)).toEqual({ which: 'next' });
  });

  it('matches the id exactly — not a prefix, substring, or other attribute', () => {
    expect(extractNextData(page('id="__NEXT_DATA__x"', '{"a":1}'))).toBeUndefined();
    expect(extractNextData(page('id="x__NEXT_DATA__"', '{"a":1}'))).toBeUndefined();
    expect(extractNextData(page('data-id="__NEXT_DATA__"', '{"a":1}'))).toBeUndefined();
    expect(extractNextData(page('class="__NEXT_DATA__"', '{"a":1}'))).toBeUndefined();
    expect(extractNextData(page('id="__next_data__"', '{"a":1}'))).toBeUndefined();
  });

  it('does not match a <scriptish> tag or the id mentioned in another script body', () => {
    const decoy = '<script>var s = \'<script id="__NEXT_DATA__">{"decoy":true}</scr\' + \'ipt>\';</script>';
    expect(extractNextData(`${decoy}<scriptx id="__NEXT_DATA__">{"a":1}</scriptx>`)).toBeUndefined();
    expect(extractNextData(`${decoy}<script id="__NEXT_DATA__">{"real":true}</script>`)).toEqual({ real: true });
  });

  it('skips a `>` inside a quoted attribute value', () => {
    expect(extractNextData('<script data-x="a>b" id="__NEXT_DATA__">{"ok":1}</script>')).toEqual({ ok: 1 });
  });

  it('accepts a closing tag with trailing whitespace or different case', () => {
    expect(extractNextData('<script id="__NEXT_DATA__">{"ok":1}</SCRIPT >')).toEqual({ ok: 1 });
  });

  it('returns undefined (never throws) on absent, unterminated, or unparseable blobs', () => {
    expect(extractNextData('<html><body>no data</body></html>')).toBeUndefined();
    expect(extractNextData('')).toBeUndefined();
    expect(extractNextData('<script id="__NEXT_DATA__">{"a":1}')).toBeUndefined();
    expect(extractNextData('<script id="__NEXT_DATA__"')).toBeUndefined();
    expect(extractNextData('<script id="__NEXT_DATA__ >{"a":1}</script>')).toBeUndefined();
    // An unterminated quoted value runs to the end: the tag never closes.
    expect(extractNextData(`<script id="__NEXT_DATA__" x='oops>{"a":1}</script>`)).toBeUndefined();
    expect(extractNextData(page('id="__NEXT_DATA__"', '{not json'))).toBeUndefined();
    expect(extractNextData(page('id="__NEXT_DATA__"', ''))).toBeUndefined();
    expect(extractNextData(page('id="__NEXT_DATA__"', '[1,2]'))).toBeUndefined();
    expect(extractNextData(page('id="__NEXT_DATA__"', '"str"'))).toBeUndefined();
  });

  it('refuses a blob over the size cap instead of parsing it', () => {
    const html = page('id="__NEXT_DATA__"', JSON.stringify({ pad: 'x'.repeat(1000) }));
    expect(extractNextData(html, { maxChars: 100 })).toBeUndefined();
    expect(extractNextData(html, { maxChars: 2000 })).toEqual({ pad: 'x'.repeat(1000) });
    expect(NEXT_DATA_MAX_CHARS).toBe(16 * 1024 * 1024);
  });

  it('uses the first matching tag', () => {
    expect(extractNextData('<script id="__NEXT_DATA__">{"n":1}</script><script id="__NEXT_DATA__">{"n":2}</script>')).toEqual({ n: 1 });
  });
});

describe('extractNextDataText', () => {
  it('returns the raw (trimmed) body so a caller can tell "absent" from "invalid JSON"', () => {
    expect(extractNextDataText(page('id="__NEXT_DATA__"', ' {not json '))).toBe('{not json');
    expect(extractNextDataText('<p>none</p>')).toBeUndefined();
  });

  it('applies the same cap and id option', () => {
    const html = page('id="__X__"', '{"a":"0123456789"}');
    expect(extractNextDataText(html, { id: '__X__', maxChars: 5 })).toBeUndefined();
    expect(extractNextDataText(html, { id: '__X__' })).toBe('{"a":"0123456789"}');
  });
});
