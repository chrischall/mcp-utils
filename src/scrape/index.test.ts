import { describe, expect, it } from 'vitest';

import {
  decodeHtmlEntities,
  deepCollectArrays,
  deepFindObject,
  extractJsonAfterMarker,
  extractJsonLdBlocks,
  findArrayByShape,
  findJsonLdEntity,
  isCloudflareChallenge,
  matchBalanced,
  ogContent,
  sanitizeJsLiterals,
  stripHtml,
  stripJsonGuard,
} from './index.js';

describe('decodeHtmlEntities', () => {
  it('decodes the common named entities', () => {
    expect(decodeHtmlEntities('a&nbsp;b &lt;x&gt; &quot;q&quot; &apos;s&apos;')).toBe(
      'a b <x> "q" \'s\'',
    );
  });

  it('decodes decimal and hex numeric references', () => {
    expect(decodeHtmlEntities('&#65;&#x42;')).toBe('AB');
  });

  it('decodes &amp; LAST so double-escaped entities survive one level', () => {
    // `&amp;lt;` is the literal text `&lt;` — NOT `<`.
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;quot;')).toBe('&quot;');
  });

  it('leaves unknown entities untouched', () => {
    expect(decodeHtmlEntities('&bogus;')).toBe('&bogus;');
  });
});

describe('stripHtml', () => {
  it('drops tags, decodes entities, collapses whitespace', () => {
    expect(stripHtml('<p>Hello&nbsp;<b>world</b>!</p>\n  <i>ok</i>')).toBe('Hello world ! ok');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('sanitizeJsLiterals', () => {
  it('replaces bare undefined with null', () => {
    expect(sanitizeJsLiterals('{"a":undefined,"b":1}')).toBe('{"a":null,"b":1}');
  });

  it('does not touch undefined inside string literals', () => {
    expect(sanitizeJsLiterals('{"a":"is undefined","b":undefined}')).toBe(
      '{"a":"is undefined","b":null}',
    );
  });

  it('does not touch identifiers that merely contain the word', () => {
    expect(sanitizeJsLiterals('{"a":"x","isUndefinedFlag":1}')).toBe(
      '{"a":"x","isUndefinedFlag":1}',
    );
  });
});

describe('matchBalanced', () => {
  it('matches a nested object with braces inside strings', () => {
    const text = 'x = {"a":{"b":"}"},"c":[1,2]}; rest';
    const start = text.indexOf('{');
    const end = matchBalanced(text, start);
    expect(text.slice(start, end)).toBe('{"a":{"b":"}"},"c":[1,2]}');
  });

  it('matches an array', () => {
    const text = '[1,[2,"]"],3]tail';
    expect(matchBalanced(text, 0)).toBe(text.length - 4);
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"a":"he said \\"}\\" ok"}';
    expect(matchBalanced(text, 0)).toBe(text.length);
  });

  it('handles single-quoted JS strings', () => {
    const text = "{'a':'}'}";
    expect(matchBalanced(text, 0)).toBe(text.length);
  });

  it('returns -1 for unbalanced input or a bad start', () => {
    expect(matchBalanced('{"a":1', 0)).toBe(-1);
    expect(matchBalanced('abc', 0)).toBe(-1);
  });
});

describe('extractJsonAfterMarker', () => {
  it('extracts an object after a marker', () => {
    const html = '<script>window.$REDUX_STATE = {"user":{"id":7}};</script>';
    expect(extractJsonAfterMarker(html, 'window.$REDUX_STATE')).toEqual({ user: { id: 7 } });
  });

  it('extracts an ARRAY after a marker (the /html extractor is objects-only)', () => {
    const html = 'var data = ["a","b"];';
    expect(extractJsonAfterMarker(html, 'var data')).toEqual(['a', 'b']);
  });

  it('tries multiple markers in order', () => {
    const html = '"appState":{"x":1}';
    expect(extractJsonAfterMarker(html, ['window.appState', '"appState"'])).toEqual({ x: 1 });
  });

  it('repairs JS literals when sanitize is on', () => {
    const html = 'window.S = {"a":undefined,"b":2};';
    expect(extractJsonAfterMarker(html, 'window.S', { sanitize: true })).toEqual({
      a: null,
      b: 2,
    });
  });

  it('returns null when the marker or JSON is missing/invalid', () => {
    expect(extractJsonAfterMarker('nothing here', 'window.S')).toBeNull();
    expect(extractJsonAfterMarker('window.S = {oops', 'window.S')).toBeNull();
  });
});

describe('extractJsonLdBlocks / findJsonLdEntity', () => {
  const html = `
    <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
    <script type='application/ld+json'>broken json</script>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Event","name":"Show","startDate":"2026-08-01"}
    </script>`;

  it('parses every well-formed block, skipping malformed ones', () => {
    const blocks = extractJsonLdBlocks(html);
    expect(blocks).toHaveLength(2);
  });

  it('finds the first entity matching @type, including inside mainEntity', () => {
    const event = findJsonLdEntity(html, 'Event') as Record<string, unknown>;
    expect(event.name).toBe('Show');

    const wrapped = `<script type="application/ld+json">
      {"@type":"WebPage","mainEntity":{"@type":"MusicEvent","name":"Gig"}}
    </script>`;
    const gig = findJsonLdEntity(wrapped, 'MusicEvent') as Record<string, unknown>;
    expect(gig.name).toBe('Gig');
  });

  it('matches an array-valued @type', () => {
    const html2 = `<script type="application/ld+json">{"@type":["Place","LocalBusiness"],"name":"Venue"}</script>`;
    const hit = findJsonLdEntity(html2, 'LocalBusiness') as Record<string, unknown>;
    expect(hit.name).toBe('Venue');
  });

  it('returns null when nothing matches', () => {
    expect(findJsonLdEntity(html, 'Recipe')).toBeNull();
  });
});

describe('ogContent', () => {
  it('reads a property-first meta tag', () => {
    expect(ogContent('<meta property="og:title" content="Hello"/>', 'og:title')).toBe('Hello');
  });

  it('reads a content-first meta tag (attribute order swapped)', () => {
    expect(ogContent('<meta content="World" property="og:site_name">', 'og:site_name')).toBe(
      'World',
    );
  });

  it('decodes entities in the content', () => {
    expect(ogContent('<meta property="og:title" content="A &amp; B">', 'og:title')).toBe('A & B');
  });

  it('returns undefined when absent', () => {
    expect(ogContent('<meta property="og:title" content="x">', 'og:image')).toBeUndefined();
  });

  it('reads a name=-keyed tag (some sites use name instead of property for OG)', () => {
    expect(ogContent('<meta name="og:title" content="Named"/>', 'og:title')).toBe('Named');
    expect(ogContent('<meta content="Twitter" name="twitter:card">', 'twitter:card')).toBe(
      'Twitter',
    );
  });
});

describe('findArrayByShape', () => {
  const pageProps = {
    misc: 1,
    savedList: [{ id: 1, address: 'x' }],
    other: ['strings'],
  };

  it('prefers a direct key when present', () => {
    expect(
      findArrayByShape(pageProps, ['savedList'], (f) => typeof f === 'object'),
    ).toEqual([{ id: 1, address: 'x' }]);
  });

  it('falls back to shape-scanning every array value', () => {
    const found = findArrayByShape(
      pageProps,
      ['missingKey'],
      (f) => typeof f === 'object' && f !== null && 'address' in (f as object),
    );
    expect(found).toEqual([{ id: 1, address: 'x' }]);
  });

  it('returns [] when nothing matches', () => {
    expect(findArrayByShape(pageProps, ['nope'], () => false)).toEqual([]);
  });
});

describe('deepCollectArrays / deepFindObject', () => {
  it('collects every array whose first item matches, despite cycles', () => {
    const root: Record<string, unknown> = {
      a: { list: [{ kind: 'hit', n: 1 }] },
      b: [[{ kind: 'hit', n: 2 }], ['no']],
    };
    root.self = root; // cycle
    const arrays = deepCollectArrays(
      root,
      (first) => typeof first === 'object' && first !== null && (first as { kind?: string }).kind === 'hit',
    );
    expect(arrays).toHaveLength(2);
  });

  it('finds the first object matching a predicate', () => {
    const root = { outer: { target: { marker: true, v: 42 } } };
    const hit = deepFindObject(root, (o) => (o as { marker?: boolean }).marker === true) as {
      v: number;
    };
    expect(hit.v).toBe(42);
    expect(deepFindObject(root, () => false)).toBeNull();
  });
});

describe('isCloudflareChallenge', () => {
  it('detects the definitive markers only', () => {
    expect(isCloudflareChallenge('<script>window._cf_chl_opt={}</script>')).toBe(true);
    expect(isCloudflareChallenge('<title>Just a moment...</title>')).toBe(true);
  });

  it('does NOT match cleared pages that merely reference challenge assets', () => {
    expect(
      isCloudflareChallenge('<script src="/cdn-cgi/challenge-platform/x.js"></script>'),
    ).toBe(false);
    expect(isCloudflareChallenge('plain page challenges.cloudflare.com mention')).toBe(false);
  });
});

describe('stripJsonGuard', () => {
  it("strips the )]}' guard", () => {
    expect(stripJsonGuard(")]}'\n{\"a\":1}")).toBe('{"a":1}');
  });

  it('strips while(1); and for(;;); guards', () => {
    expect(stripJsonGuard('while(1);{"a":1}')).toBe('{"a":1}');
    expect(stripJsonGuard('for(;;);["x"]')).toBe('["x"]');
  });

  it('strips the {}&& guard (redfin stingray)', () => {
    expect(stripJsonGuard('{}&&{"payload":1}')).toBe('{"payload":1}');
  });

  it('leaves unguarded JSON untouched', () => {
    expect(stripJsonGuard('{"a":1}')).toBe('{"a":1}');
  });
});
