/**
 * Internal (not exported from any entry point): `String.fromCodePoint` for a
 * scraped numeric character reference, made SAFE. Shared by
 * `scrape#decodeHtmlEntities` and `html#extractPlainTextFromHtml`, which each
 * carried a copy.
 *
 * Returns `raw` (the entity text, unchanged) instead of decoding when the code
 * point is not a character:
 *  - out of range (negative, non-integer, or > 0x10FFFF, e.g.
 *    `&#999999999999;`), where `String.fromCodePoint` would throw `RangeError`
 *    and crash the extractor on hostile input;
 *  - a surrogate (U+D800–U+DFFF). These do not throw — they yield an unpaired
 *    UTF-16 unit, which is invalid text that breaks later UTF-8 encoding. HTML
 *    maps such a reference to U+FFFD; leaving it verbatim matches
 *    musescore-mcp's `decodeText` (chrischall/fleet-audit#1062) and the
 *    out-of-range rule above. A hand-written `&#xD83D;&#xDE00;` pair is
 *    refused too: each reference is judged alone, as HTML does.
 */
export function codePointOr(code: number, raw: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return raw;
  if (code >= 0xd800 && code <= 0xdfff) return raw;
  return String.fromCodePoint(code);
}
