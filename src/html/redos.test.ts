import { describe, expect, it } from 'vitest';

import { extractPlainTextFromHtml } from './index.js';

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
  });
});
