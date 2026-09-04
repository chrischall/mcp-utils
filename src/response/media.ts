/**
 * Drop image and avatar references from a payload.
 *
 * This is the single highest-value, lowest-risk projection in the fleet, and it
 * needs no knowledge of the API at all. Measured on a real
 * `splitwise-mcp sw_list_groups` response — 51 groups, 187.6 KB, which does not
 * fit in a tool result at all and fails outright:
 *
 * | | size | |
 * |---|---|---|
 * | as shipped (pretty) | 187.6 KB | — |
 * | minified | 140.5 KB | −25% |
 * | minified + media stripped | **51.4 KB** | **−73%** |
 *
 * 60% of that payload was `avatar`, `tall_avatar`, `cover_photo` and a
 * `picture` per member — URLs a model cannot see, cannot fetch, and would not
 * benefit from if it could.
 *
 * **Why not also drop nulls.** It was the obvious companion rule and it is
 * rejected on purpose: measured on the same payload it buys three further
 * points (−73% → −75%), and it costs meaning. `ofw-mcp` emits
 * `recipients[].viewedAt: null` to say "this person has never opened it",
 * which is evidence in a custody record; an absent key and a null one are the
 * same to `JSON.parse` but not to a reader deciding whether the question was
 * answered. Three points is not worth a payload that can no longer distinguish
 * "no value" from "not reported".
 *
 * **Never apply this to a tool whose PRODUCT is the image.**
 * `alltrails_get_trail_photos`, `zillow_get_property_photos`,
 * `sw_get_receipt`, `musescore_fetch_svgs` exist to return exactly these URLs,
 * and stripping them there does not shrink the response, it empties it. The
 * tool's own name is the test. `keep` is the escape hatch for a payload that
 * mixes both.
 */

/** Keys whose value is a picture, whatever it holds. */
const MEDIA_KEY =
  /^(avatar|tall_avatar|cover_photo|cover_image|picture|photo|thumbnail|thumb|image|icon|banner|profile_pic(ture)?|logo)s?$/i;

/** A URL that points at an image rather than at a page. */
const MEDIA_URL = /^https?:\/\/[^\s]+?(\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)(\?|#|$)|\/avatars?\/|_avatars?\/|\bavatar\b)/i;

export interface StripMediaOptions {
  /**
   * Keys to keep even when they look like media — for a payload that mixes a
   * decorative avatar with an image the caller actually asked for.
   */
  keep?: readonly string[];
}

/**
 * Return a copy of `value` with media keys and bare image URLs removed.
 *
 * Recurses through arrays and plain objects. Everything else — strings,
 * numbers, booleans, **null**, Dates — is passed through untouched, so a
 * `null` that means "never viewed" survives.
 *
 * The input is never mutated: several repos hand these helpers live cache rows.
 */
export function stripMediaUrls<T>(value: T, opts: StripMediaOptions = {}): T {
  const keep = new Set((opts.keep ?? []).map((k) => k.toLowerCase()));
  return walk(value, keep) as T;
}

function walk(value: unknown, keep: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, keep));
  // `null` is data here, not an empty object — see the docblock.
  if (value === null || typeof value !== 'object') return value;
  // Anything with a prototype of its own (Date, Map, a class instance) is left
  // alone: rebuilding it from its enumerable keys would quietly change what it
  // is, and none of them carry avatars.
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (keep.has(key.toLowerCase())) {
      out[key] = v;
      continue;
    }
    if (MEDIA_KEY.test(key)) continue;
    if (typeof v === 'string' && MEDIA_URL.test(v)) continue;
    out[key] = walk(v, keep);
  }
  return out;
}
