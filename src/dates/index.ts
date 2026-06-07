/**
 * Date-format converters for upstreams that don't speak ISO 8601, so an MCP can
 * keep its surface ISO (`yyyy-MM-dd`) and translate at the API boundary.
 *
 * Pair with {@link deepMapStringField} (from the `response` module) to rewrite a
 * date field throughout a response, e.g.
 * `deepMapStringField(data, 'eventDate', dmyToIso)`.
 */

// These are pure *lexical* reformats — no Date/Intl on purpose. `new Date('2025-08-28')`
// parses as UTC midnight, so reading it back with local getters shifts the day in any
// behind-UTC zone (the classic date-only off-by-one), and Intl can't emit dd-MM-yyyy /
// yyyyMMddHHmmss anyway. Reformatting the digits is timezone-safe and dependency-free.
// Inputs that don't match a known shape (incl. timezone-aware ones) pass through; we don't
// validate the calendar — the upstream API is the source of truth for that.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_DATE = /^(\d{2})-(\d{2})-(\d{4})$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** ISO `yyyy-MM-dd` → `dd-MM-yyyy`. Non-ISO input is trimmed and passed through. */
export function isoToDmy(date: string): string {
  const m = ISO_DATE.exec(date.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : date.trim();
}

/** `dd-MM-yyyy` → ISO `yyyy-MM-dd`. Non-matching input is trimmed and passed through. */
export function dmyToIso(date: string): string {
  const m = DMY_DATE.exec(date.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : date.trim();
}

/**
 * ISO `yyyy-MM-dd` (or `yyyy-MM-ddTHH:mm[:ss]`) → a compact `yyyyMMddHHmmss`
 * stamp. A bare date gets `000000`; an already-14-digit value passes through;
 * anything else is trimmed and passed through.
 */
export function isoToCompactTimestamp(value: string): string {
  const v = value.trim();
  const d = ISO_DATE.exec(v);
  if (d) return `${d[1]}${d[2]}${d[3]}000000`;
  const dt = ISO_DATETIME.exec(v);
  if (dt) return `${dt[1]}${dt[2]}${dt[3]}${dt[4]}${dt[5]}${dt[6] ?? '00'}`;
  return v;
}
