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

/**
 * Keys whose value is a picture, whatever it holds.
 *
 * The optional `Link|Uri|Url` suffix is what makes this work outside
 * consumer-social APIs. Splitwise names a picture `avatar`; every Google
 * Workspace API names it `thumbnailLink`, `iconUri`, `photoUrl`. Without the
 * suffix this rule matched NONE of them — measured on a real `gog drive ls`
 * listing of 25 rows, `thumbnailLink` alone was 4,973 bytes of 15,698 (32% of
 * the payload) and this helper removed zero of it. Nor does MEDIA_URL cover the
 * gap: Google's media URLs are extension-less signed URLs. Adding the suffix
 * takes that listing down 31%, and `drive search` — which supports no field
 * mask at all, so nothing else can shrink it — down 30%.
 *
 * The anchor stays at the START, which is the whole safety property. A key that
 * merely CONTAINS a media noun is untouched, so Drive's `hasThumbnail: false`
 * survives: it is a fact about the file, and a caller filtering on it would
 * otherwise see the key vanish and read that as "not reported". Only the three
 * reference suffixes are added, so `thumbnailWidth` (a number) and
 * `imageMediaMetadata` (EXIF) stay too — and so does `webViewLink`, whose noun
 * is not media and which sits in the same object as `thumbnailLink`.
 *
 * The trailing `s?` after the suffix closes a gap the suffix opened: the
 * pattern matched `imageUrl` and `images`, but not `imageUrls`. Those plurals
 * are not hypothetical — `imageUrls`, `photoUrls` and `avatarUrls` appear 33
 * times across groupon-mcp and redfin-mcp — and a rule that catches the
 * singular while missing the plural of the same field is the kind of half-cover
 * that reads as working.
 */
const MEDIA_NOUN = '(?:avatar|tall_avatar|cover_photo|cover_image|picture|photo|thumbnail|thumb|image|icon|banner|profile_pic(?:ture)?|logo)';

const MEDIA_KEY = new RegExp(`^${MEDIA_NOUN}s?(?:(?:link|uri|url)s?)?$`, 'i');

/**
 * A URL that points at an image rather than at a page: a known image extension
 * ending the PATH.
 *
 * Nothing looser. Earlier drafts also matched an `avatar` path segment and a
 * bare `avatar` word, and both were false positives waiting to happen —
 * `…/users/avatar-collection` and `…/v1/avatar/settings` are pages, and this
 * helper's whole promise is that it keeps pages. Measured on the payload that
 * motivated the helper, the extra clauses removed exactly ZERO additional
 * bytes: every avatar in a real Splitwise response is either under a media KEY
 * (caught by `MEDIA_KEY`, whatever the URL looks like) or ends in `.png`/`.jpg`.
 * A rule that adds risk and removes nothing is not a rule.
 *
 * The extension must END the path, so a signed URL whose query happens to
 * contain `.jpeg` — Splitwise's `…/receipt?cachebust=29f.jpeg&size=large` — is
 * KEPT. That one is content a caller asked for, not decoration.
 */
const MEDIA_URL = /^https?:\/\/[^\s]+?\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)([?#]|$)/i;

export interface StripMediaOptions {
  /**
   * Keys to keep even when they look like media — for a payload that mixes a
   * decorative avatar with an image the caller actually asked for.
   */
  keep?: readonly string[];
  /**
   * Extra keys to drop, for a service whose naming this pattern does not know.
   *
   * The symmetric half of `keep`, and the point is that a repo should not need
   * a LIBRARY RELEASE to strip its own noise. That is exactly what happened
   * once already: Google Workspace names every picture `thumbnailLink` /
   * `iconUri` / `photoUrl`, none of which the original pattern matched, and
   * closing it took a version bump across every consumer. The next service with
   * an unguessed convention can now fix itself locally and propose the pattern
   * change at leisure.
   *
   * A string matches a key exactly, case-insensitively; a RegExp is tested
   * against the key as given.
   */
  drop?: readonly (string | RegExp)[];
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
  const drop = opts.drop ?? [];
  return walk(value, keep, drop) as T;
}

/** Does `key` match one of the caller's extra drop rules? */
function alsoDrop(key: string, drop: readonly (string | RegExp)[]): boolean {
  for (const rule of drop) {
    if (typeof rule === 'string' ? rule.toLowerCase() === key.toLowerCase() : rule.test(key)) return true;
  }
  return false;
}

function walk(value: unknown, keep: ReadonlySet<string>, drop: readonly (string | RegExp)[]): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, keep, drop));
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
    if (MEDIA_KEY.test(key) || alsoDrop(key, drop)) continue;
    if (typeof v === 'string' && MEDIA_URL.test(v)) continue;
    out[key] = walk(v, keep, drop);
  }
  return out;
}
