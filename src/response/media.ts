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
 * **Arrays of bare image URLs under a non-media key are KEPT** — see the note
 * in `walk`. Use `drop` for those; the key rule already covers an array under
 * a media-named key (`photos: [...]`).
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
 * are not hypothetical — `imageUrls` appears 5 times in groupon-mcp and
 * `photoUrls` 17 times in redfin-mcp — and a rule that catches the singular
 * while missing the plural of the same field is the kind of half-cover that
 * reads as working. (Counted with `grep -rhoE` over both repos excluding
 * node_modules. An earlier draft said 33 across the two and named `avatarUrls`
 * as a third form; neither reproduced.)
 */
const MEDIA_NOUN = '(?:avatar|picture|photo|thumbnail|thumb|image|icon|banner|profile_pic(?:ture)?|logo)';

/**
 * A bounded set of qualifiers that may precede the noun in a snake_case or
 * kebab-case key: `primary_photo_url`, `profile_image_url`, `hero-banner`.
 *
 * CLOSED on purpose, never `\w+`. That is the whole difference between this
 * and the two clauses removed in #191 — a bare `\bavatar\b` and an
 * `/avatars?/` path segment — which were open-ended, stripped genuine page
 * URLs, and (measured) removed zero bytes. A media noun is also allowed here,
 * for `avatar_image_url`.
 *
 * `cover` and `tall` live here rather than as `cover_photo` / `cover_image` /
 * `tall_avatar` entries in MEDIA_NOUN. Those three were redundant once this
 * list existed — `cover` + `photo` already composes — and keeping both spellings
 * meant the snake_case form matched while the camelCase one silently did not.
 *
 * The separator is OPTIONAL for the same reason. With `[_-]` required,
 * `cover_photo` was stripped and `coverPhoto` was kept: the same field, the
 * same meaning, a different answer decided by an API's casing convention. That
 * asymmetry is the exact shape of the bug #197 was about, one level up.
 */
const MEDIA_QUALIFIER =
  '(?:primary|secondary|main|default|cover|hero|profile|master|rendered|small|medium|large|full|original|tall)';

const MEDIA_KEY = new RegExp(
  `^(?:(?:${MEDIA_QUALIFIER}|${MEDIA_NOUN})[_-]?)?${MEDIA_NOUN}s?(?:[_-]?(?:link|uri|url|src)s?)?$`,
  'i',
);

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
   * against the key as given, whatever flags it carries — see `stripMediaUrls`
   * for why a `g` or `y` rule needs care.
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
  // Every RegExp rule is COPIED, once per call, for two reasons.
  //
  // `test()` on a `g`- or `y`-flagged regex advances `lastIndex` on a match, so
  // one rule object tested across a sequence of keys silently skips the next key
  // whose length falls inside the advanced index. It fails OPEN — the key
  // survives — and which key survives depends on the ORDER they are walked in,
  // so it reads as "the rule did not match" rather than as a bug. Nothing in the
  // type forbids a `/g`, and `/^blur/gi` is a natural thing to write.
  //
  // Copying rather than resetting the caller's own regex keeps the promise this
  // helper already makes about payloads: it never mutates its input, and a
  // caller's RegExp is input too. The docs invite hoisting `drop` as a shared
  // constant, which is exactly when someone else's `lastIndex` would be ours to
  // corrupt. Strings are lowercased here for the same once-per-call reason.
  const drop: (string | RegExp)[] = (opts.drop ?? []).map((rule) =>
    typeof rule === 'string' ? rule.toLowerCase() : new RegExp(rule.source, rule.flags));
  return walk(value, keep, drop) as T;
}

/** Does `key` match one of the caller's extra drop rules? */
function alsoDrop(key: string, drop: readonly (string | RegExp)[]): boolean {
  const lower = key.toLowerCase();
  for (const rule of drop) {
    if (typeof rule === 'string') {
      if (rule === lower) return true;
      continue;
    }
    // Our own copy, so resetting is free and invisible to the caller.
    rule.lastIndex = 0;
    if (rule.test(key)) return true;
  }
  return false;
}

function walk(value: unknown, keep: ReadonlySet<string>, drop: readonly (string | RegExp)[]): unknown {
  // Array ELEMENTS are walked but never value-tested, so an array of bare image
  // URLs under a non-media key — homes-mcp's `floorplan_urls` — comes back
  // whole. That is deliberate, and it is the one place this helper knowingly
  // leaves bytes on the table.
  //
  // Removing a KEY is visible: the field is gone and a reader can see that it
  // is. Removing ELEMENTS is invisible — the array is merely shorter, and a
  // caller reading `floorplan_urls.length` to say "this listing has 4 floor
  // plans" would be quietly wrong. That is the same class of harm as the
  // dropped-nulls rule this helper also refuses (see the docblock above):
  // a silently altered count reads as fact.
  //
  // The fix for such a field is `drop: ['floorplan_urls']` at the call site,
  // which removes the key outright and stays legible in the response.
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
