/**
 * Date-format converters for upstreams that don't speak ISO 8601, so an MCP can
 * keep its surface ISO (`yyyy-MM-dd`) and translate at the API boundary.
 *
 * Pair with {@link deepMapStringField} (from the `response` module) to rewrite a
 * date field throughout a response, e.g.
 * `deepMapStringField(data, 'eventDate', dmyToIso)`.
 */

import { readEnvVar, type EnvSource } from '../config/index.js';

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
 * The fleet-wide env var naming the **user's** IANA time zone (e.g.
 * `America/New_York`). Hosted servers (mcp-host) run every child in **UTC**,
 * so without it "today" rolls over at UTC midnight — 7 or 8 pm on the US east
 * coast. mcp-host can set it per registration; on a laptop it is normally
 * unset and the host zone (the user's own) is used.
 */
export const USER_TIME_ZONE_ENV = 'MCP_USER_TZ';

/** `true` when `timeZone` is an IANA zone name this runtime's `Intl` knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Options for {@link resolveUserTimeZone} and {@link todayIso}. */
export interface UserTimeZoneOptions {
  /** An explicit IANA zone; wins over {@link USER_TIME_ZONE_ENV}. */
  timeZone?: string;
  /** Where to read {@link USER_TIME_ZONE_ENV} from. Defaults to `process.env`. */
  env?: EnvSource;
}

/**
 * The user's time zone: the explicit `timeZone` → a valid
 * {@link USER_TIME_ZONE_ENV} (`MCP_USER_TZ`) → `undefined`, meaning "the host
 * zone". The env value is read through the hardened {@link readEnvVar}, and a
 * value `Intl` doesn't recognise is ignored rather than thrown, like any other
 * bad env value. An explicit `timeZone` is returned as given (validate it with
 * {@link isValidTimeZone}, or let {@link todayIso} throw on it).
 */
export function resolveUserTimeZone(opts: UserTimeZoneOptions = {}): string | undefined {
  if (opts.timeZone !== undefined) return opts.timeZone;
  const fromEnv = readEnvVar(USER_TIME_ZONE_ENV, { env: opts.env });
  return fromEnv !== undefined && isValidTimeZone(fromEnv) ? fromEnv : undefined;
}

/** Options for {@link todayIso}. */
export interface TodayIsoOptions extends UserTimeZoneOptions {
  /** The instant to read; defaults to now. Pin it in tests. */
  now?: Date;
}

/**
 * Today's date as ISO `yyyy-MM-dd` in the **user's** zone — "today" for a
 * user booking a reservation means their wall-clock date, not UTC (resy's
 * `todayYMD`).
 *
 * The zone is `opts.timeZone` → the `MCP_USER_TZ` env var
 * ({@link USER_TIME_ZONE_ENV}) → the host's local zone. **Hosted servers run
 * in UTC**, so on mcp-host the host-zone fallback is UTC; set `MCP_USER_TZ` (or
 * pass `timeZone`) there. An invalid explicit `timeZone` throws a `RangeError`;
 * an invalid `MCP_USER_TZ` is ignored.
 *
 * The legacy `todayIso(date)` form still works and reads the same env var;
 * with `MCP_USER_TZ` unset it is the host-local date, exactly as before.
 */
export function todayIso(nowOrOpts?: Date | TodayIsoOptions): string {
  const opts: TodayIsoOptions = nowOrOpts instanceof Date ? { now: nowOrOpts } : (nowOrOpts ?? {});
  const now = opts.now ?? new Date();
  const timeZone = resolveUserTimeZone(opts);
  if (timeZone === undefined) {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Invalid IANA time zone: ${timeZone}`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
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
