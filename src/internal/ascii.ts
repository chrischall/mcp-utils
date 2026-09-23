/**
 * Internal text helpers shared by the `scrape` (core) and `html` (subpath)
 * modules. Zero-dep, and deliberately NOT in `package.json#exports`.
 */

/**
 * Lowercase ASCII letters only. Unlike `String#toLowerCase`, this is
 * length-preserving (`'İ'` lowercases to TWO UTF-16 units), so offsets found in
 * the result index the original string correctly. HTML tag and attribute
 * names are ASCII, so nothing is lost.
 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}
