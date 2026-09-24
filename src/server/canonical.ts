// Internal (not re-exported from the barrel): the one canonical form both
// confirmation mechanisms commit to — requireConfirmation's `binding` state and
// the confirm-token fallback — so two calls that differ in any value never
// share a commitment in either.

/**
 * A canonical, type-tagged serialisation of tool arguments for the binding
 * commitment. Object keys are sorted, so `{a,b}` and `{b,a}` hash the same.
 * Values JSON would flatten to `{}` are serialised faithfully instead — a
 * `Date` as its ISO string, bytes (`Buffer`, typed arrays, `ArrayBuffer`) as
 * base64, a `Map`/`Set` as its entries sorted by canonical form, a `bigint` as
 * its digits — so two calls that differ only in such a value never share a
 * commitment. Each typed value is a one-key `{"$tag":…}` object; a plain
 * object's `$`-prefixed keys are escaped (see {@link escapeKey}), so a plain
 * object that imitates a tag (`{ $bytes: 'dHdv' }`) never encodes the same as
 * the typed value it imitates (`Buffer.from('two')`). Anything else that is not plain data (a class instance, a
 * function, a symbol) cannot be compared honestly and is refused.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : `{"$num":"${String(value)}"}`;
  if (typeof value === 'bigint') return `{"$bigint":"${value.toString()}"}`;
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`confirmation: cannot bind a ${typeof value} argument value.`);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Date) {
    return `{"$date":${JSON.stringify(Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString())}}`;
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return `{"$bytes":${JSON.stringify(bytes.toString('base64'))}}`;
  }
  if (value instanceof ArrayBuffer) return `{"$bytes":${JSON.stringify(Buffer.from(value).toString('base64'))}}`;
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([k, v]) => `[${canonicalJson(k)},${canonicalJson(v)}]`).sort();
    return `{"$map":[${entries.join(',')}]}`;
  }
  if (value instanceof Set) {
    return `{"$set":[${[...value].map(canonicalJson).sort().join(',')}]}`;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('confirmation: cannot bind a non-plain object argument value (class instance).');
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(escapeKey(k))}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Escape a plain-object key so it can never collide with a type tag. Tags are
 * `$` followed by a letter (`$bytes`, `$date`, …); every plain key that starts
 * with `$` gains one more, so plain keys starting with `$` always start with
 * `$$` and never match a tag. Prefixing is injective, so distinct keys stay
 * distinct (`$x` → `$$x`, `$$x` → `$$$x`).
 */
function escapeKey(key: string): string {
  return key.startsWith('$') ? `$${key}` : key;
}
