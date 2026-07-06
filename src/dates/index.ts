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

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Today's date in the **local** timezone as ISO `yyyy-MM-dd`. This is the one
 * place a `Date` is deliberately read with local getters — "today" for a user
 * booking a reservation means their wall-clock date, not UTC (resy's
 * `todayYMD`). Pass a `Date` to pin the clock (tests).
 */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * A `Date`'s **UTC** calendar date as ISO `yyyy-MM-dd` — the UTC counterpart of
 * {@link todayIso} for APIs whose day boundaries are UTC (creditkarma's
 * `utcDateString`).
 */
export function toIsoDateUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Shift an ISO `yyyy-MM-dd` date by `days` (negative to go back), staying
 * calendar-correct across month/year boundaries and leap days. The arithmetic
 * runs entirely in UTC so a behind-UTC local zone can't shift the result (the
 * classic date-only off-by-one). Non-ISO input is trimmed and passed through,
 * matching the module convention.
 */
export function shiftIsoDate(date: string, days: number): string {
  const m = ISO_DATE.exec(date.trim());
  if (!m) return date.trim();
  const shifted = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return toIsoDateUtc(shifted);
}

const HM_TIME = /^(\d{2}):(\d{2})$/;
const HMS_TIME = /^\d{2}:\d{2}:\d{2}$/;

/**
 * Normalize a time to `HH:MM:SS`: a bare `HH:MM` gains `:00`, an `HH:MM:SS`
 * passes through, anything else is trimmed and passed through. The inverse
 * direction of the zod module's `extractTime` (which trims seconds OFF), for
 * upstreams that require the seconds field (resy's `padSeconds`).
 */
export function ensureSeconds(time: string): string {
  const t = time.trim();
  if (HM_TIME.test(t)) return `${t}:00`;
  if (HMS_TIME.test(t)) return t;
  return t;
}
