/**
 * Drop every key whose NAME looks like a reference or a credential — a path,
 * URL, link, token, secret, key or signature — from a record a tool is about
 * to return.
 *
 * Promoted from insync-mcp (`src/tools/_shared.ts`), where it guards portal
 * attachment rows. Those rows carry the file's metadata beside a
 * session-authorized fetch URL (`FILEPATH`, `Thumbnailurl`, a SAS token) that
 * works for anyone holding it. A model has no use for that URL, and echoing it
 * into a transcript hands the session's reach to whoever reads the transcript.
 *
 * **Why a SUBSTRING match, case-insensitively, and not a word-segment one.**
 * This is the whole point of the helper, and it was learned the hard way
 * (insync-mcp #4 → #5 → #6). The first version split camelCase / snake_case
 * names into words and matched whole words. It failed OPEN on exactly the
 * fields it existed to hide: a segmenter has nothing to split in `FILEPATH`,
 * `filepath`, `Thumbnailurl` or `TOKENVALUE`, so each read as one unknown word
 * and was kept — and real upstreams name fields exactly that way. A filter
 * that is wrong in the permissive direction is worse than none, because it
 * reads as covered. So any key that CONTAINS one of the words is dropped.
 *
 * **The accepted cost** is dropping an ordinary word that happens to contain a
 * token: `Monkey` (key), `Keyboard` (key), `Pathway` (path). That direction is
 * harmless — a missing harmless field, visibly absent — where the other
 * direction leaks a credential. Do not "fix" it with word boundaries.
 *
 * **One level only.** It filters the record's OWN keys; a nested object or
 * array is passed through untouched, by reference. Call it on each record you
 * project (or on the nested record too) — it is a field filter for a known
 * row shape, not a deep walker like `stripMediaUrls`.
 *
 * **Fail closed on shape, too.** Anything that is not a plain object — an
 * array, `null`, a primitive, a `Date` or class instance — yields `{}`, never
 * the input. A tool that expected a row and got something else returns
 * nothing rather than whatever the upstream sent.
 */

/**
 * The built-in words. A plain alternation of literals with no quantifier, so a
 * scan is linear in the key length — the posture every pattern in this package
 * keeps, even though this one only ever sees key names.
 */
const URLISH = /path|url|uri|src|source|link|href|token|secret|key|sas|signature/i;

export interface StripUrlishKeysOptions {
  /**
   * Further words to drop, matched exactly like the built-ins: a
   * case-insensitive SUBSTRING of the key name. For a service whose credential
   * fields this list does not know (`sessionGuid`, `ticket`), so it can close
   * the gap locally without a library release.
   *
   * Additive only — there is no way to re-admit a built-in word. Empty strings
   * are ignored (an empty substring would match, and so drop, every key).
   * Matched with `String#includes`, not a regex, so no caller-supplied pattern
   * can be superlinear or carry `lastIndex` state.
   */
  extraWords?: readonly string[];
}

/** Plain object (`{}` or `Object.create(null)`) — the only shape that is filtered. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Return a shallow copy of `value` without any key whose name contains `path`,
 * `url`, `uri`, `src`, `source`, `link`, `href`, `token`, `secret`, `key`,
 * `sas` or `signature` (case-insensitive substring), plus any `extraWords`.
 *
 * Non-plain-object input yields `{}`. One level only: nested values are kept
 * as-is. The input is never mutated. See the module docblock for why this is a
 * substring match and what that costs.
 */
export function stripUrlishKeys(value: unknown, opts: StripUrlishKeysOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainRecord(value)) return out;
  const extra = (opts.extraWords ?? []).filter((w) => w !== '').map((w) => w.toLowerCase());
  for (const [k, v] of Object.entries(value)) {
    if (URLISH.test(k)) continue;
    if (extra.length > 0) {
      const lower = k.toLowerCase();
      if (extra.some((w) => lower.includes(w))) continue;
    }
    out[k] = v;
  }
  return out;
}
