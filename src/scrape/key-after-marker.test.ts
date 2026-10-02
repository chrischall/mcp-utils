import { describe, it, expect } from 'vitest';
import { extractJsonKeyAfterMarker } from './index.js';

// fleet-audit#1130: "extract the value of top-level key K of the object after
// marker M" — tock's extractReduxSlice, generalised. The store as a whole is
// not parseable (a sibling slice embeds functions), but each slice is.

const MARKERS = ['window.$REDUX_STATE', '"$REDUX_STATE"', '$REDUX_STATE'];

// The real Tock store embeds inline `function` values in the `navigation` slice.
const store =
  '<script>window.$REDUX_STATE = {' +
  '"navigation":{"onClose":function noop(a, b){return {a:1, "calendar": [b]}},"depth":2},' +
  '"calendar":{"offerings":{"experience":[{"name":"Salon","id":1}],"openDate":["2026-07-10"]}},' +
  '"app":{"business":{"domainName":"alinea","name":"Alinea","jwtToken":undefined}},' +
  '"patron":null,"count":3,"flag":false,"label":"a \\"quoted\\" } brace"' +
  '};</script>';

describe('extractJsonKeyAfterMarker', () => {
  it('extracts a named slice past a sibling full of function literals', () => {
    const cal = extractJsonKeyAfterMarker(store, MARKERS, 'calendar') as any;
    expect(cal.offerings.experience[0].name).toBe('Salon');
    expect(cal.offerings.openDate).toEqual(['2026-07-10']);
  });

  it('only matches top-level keys, never a same-named key nested in a sibling', () => {
    const html = 'S = {"outer":{"target":1},"target":2}';
    expect(extractJsonKeyAfterMarker(html, 'S', 'target')).toBe(2);
    const nestedOnly = 'S = {"outer":{"target":1}}';
    expect(extractJsonKeyAfterMarker(nestedOnly, 'S', 'target')).toBeUndefined();
  });

  it('ignores a key-like string inside a value (string-aware)', () => {
    const html = 'S = {"a":"\\"b\\":9, ","b":7}';
    expect(extractJsonKeyAfterMarker(html, 'S', 'b')).toBe(7);
  });

  it('sanitizes bare undefined inside the slice when asked', () => {
    expect(extractJsonKeyAfterMarker(store, MARKERS, 'app')).toBeUndefined(); // invalid JSON unsanitised
    const app = extractJsonKeyAfterMarker(store, MARKERS, 'app', { sanitize: true }) as any;
    expect(app.business).toMatchObject({ domainName: 'alinea', jwtToken: null });
  });

  it('returns scalar, null and string values', () => {
    expect(extractJsonKeyAfterMarker(store, MARKERS, 'count')).toBe(3);
    expect(extractJsonKeyAfterMarker(store, MARKERS, 'flag')).toBe(false);
    expect(extractJsonKeyAfterMarker(store, MARKERS, 'patron')).toBeNull();
    expect(extractJsonKeyAfterMarker(store, MARKERS, 'label')).toBe('a "quoted" } brace');
  });

  it('returns undefined (not null) when the key is absent, so a null slice stays distinguishable', () => {
    expect(extractJsonKeyAfterMarker(store, MARKERS, 'missing')).toBeUndefined();
  });

  it('returns undefined when the marker is absent or no object follows it', () => {
    expect(extractJsonKeyAfterMarker('<html>nothing</html>', MARKERS, 'app')).toBeUndefined();
    expect(extractJsonKeyAfterMarker('window.$REDUX_STATE = ', MARKERS, 'app')).toBeUndefined();
  });

  it('returns undefined on an unterminated value', () => {
    expect(extractJsonKeyAfterMarker('S = {"a":{"b":1', 'S', 'a')).toBeUndefined();
    expect(extractJsonKeyAfterMarker('S = {"a":"unterminated', 'S', 'a')).toBeUndefined();
  });

  it('accepts single-quoted and bare identifier keys and whitespace around the colon', () => {
    const html = "S = { 'one' : [1, 2] ,\n  two: {\"x\": 1}, $three_3 :\t'skip', four: 4 }";
    expect(extractJsonKeyAfterMarker(html, 'S', 'one')).toEqual([1, 2]);
    expect(extractJsonKeyAfterMarker(html, 'S', 'two')).toEqual({ x: 1 });
    expect(extractJsonKeyAfterMarker(html, 'S', 'four')).toBe(4);
  });

  it('decodes escapes in a double-quoted key before comparing', () => {
    expect(extractJsonKeyAfterMarker('S = {"a\\u0062":5}', 'S', 'ab')).toBe(5);
  });

  it('uses the first marker that is present, in list order', () => {
    const html = 'B = {"k":2} A = {"k":1}';
    expect(extractJsonKeyAfterMarker(html, ['A', 'B'], 'k')).toBe(1);
    expect(extractJsonKeyAfterMarker(html, 'B', 'k')).toBe(2);
  });

  it('is linear on a 200 KB object of many siblings', () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `"k${i}":{"v":[${i}]}`).join(',');
    const html = `S = {${body},"last":1}`;
    const t = performance.now();
    expect(extractJsonKeyAfterMarker(html, 'S', 'last')).toBe(1);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
