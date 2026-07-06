/**
 * `zod` — schema atoms, pagination, and tool-annotation helpers shared across
 * the MCP fleet. Intentionally small: atoms + annotations, not a schema
 * framework. Built on zod v4.
 *
 * The raw-shape style (`inputSchema: { foo: z.string() }`) used by
 * `server.registerTool` is preserved — these atoms are plain `ZodType`s you
 * drop straight into a shape object.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

/** A strictly positive integer (`> 0`). */
export const PositiveInt = z.number().int().positive();

/** A non-negative integer (`>= 0`). */
export const NonNegInt = z.number().int().nonnegative();

/** A non-empty string (after no trimming — at least one character). */
export const NonEmptyString = z.string().min(1);

/**
 * An ISO calendar date, `YYYY-MM-DD`. Rejects impossible dates (e.g.
 * `2026-13-01`) via zod v4's `z.iso.date()`.
 */
export const IsoDate = z.iso.date();

/**
 * A 24-hour wall-clock time `HH:MM` (no seconds, no offset). This is the
 * fleet convention (resy notify/book, slot windows) — restaurant-local times
 * carried as bare `HH:MM`, never parsed through `Date` so they aren't shifted
 * by the server's timezone. Accepts `9:05` and `09:05`; rejects `24:00`,
 * `19:60`, and anything with seconds.
 */
export const IsoTime = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h), e.g. 19:30');

/**
 * A bare numeric id as a string, e.g. App Store Connect's `1234567890`.
 * Exactly one-or-more ASCII digits — no signs, decimals, or whitespace.
 *
 * Use for ids that are interpolated into request paths so a non-numeric value
 * (or a traversal payload) can't slip through. (app-store-connect numeric ids.)
 */
export const NumericIdString = z
  .string()
  .regex(/^\d+$/, 'must be a numeric id (digits only)')
  .describe('A numeric id string (digits only), safe to interpolate into a URL path.');

/**
 * A single, safe URL path segment: rejects the traversal / injection
 * characters `/`, `..`, `?`, `#`, and any whitespace. The fleet-standard
 * hardening for caller-supplied ids that get interpolated into request paths
 * (tempo account ids, ASC ids, gemini path ids) — defense-in-depth against
 * path traversal and query/fragment injection.
 *
 * This is a DENYLIST (`/^[^/?#\s]+$/` + no-`..`): it permits any character
 * except the traversal/injection set, so it's strictly less restrictive than a
 * per-id allowlist. Repos that hand-roll a stricter allowlist (e.g. tempo's
 * AccountId `/^[A-Za-z0-9:_.-]+$/`) should KEEP it rather than swap to this —
 * swapping would widen their accepted input. Use this atom for ids that have no
 * tighter character constraint; it's the floor, not a replacement for a
 * site-specific allowlist.
 */
export const SafePathSegment = z
  .string()
  .min(1)
  .regex(/^[^/?#\s]+$/, 'must not contain "/", "?", "#", or whitespace')
  .refine((v) => !v.includes('..'), 'must not contain ".."')
  .describe(
    'A single URL path segment, safe to interpolate: no "/", "..", "?", "#", or whitespace.'
  );

/**
 * Optional portal-origin selector (e.g. `https://<vendor>.hbportal.co`).
 * Disambiguates which signed-in session a tool routes through when more than
 * one is active. Optional — when a single session is active it can be omitted.
 * (honeybook / disk-session MCPs)
 */
export const schemaOrigin = z
  .string()
  .optional()
  .describe(
    'Portal origin (e.g. https://<vendor>.example.co) selecting which active session to use. Optional when only one session is active.'
  );

/**
 * The write-confirmation gate shared by mutating tools: without
 * `confirm: true` the tool returns a preview instead of performing the action.
 * (honeybook pay_invoice / sign_contract)
 */
export const schemaConfirm = z
  .boolean()
  .optional()
  .describe('Must be true to proceed. Without this, the tool returns a preview.');

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Offset/limit pagination shape (raw, for spreading into an `inputSchema`).
 * `offset` defaults to 0, `limit` is bounded `1..200` and defaults to 50 —
 * the bounds standardized across the fleet's search tools.
 */
export const paginationSchema = {
  offset: NonNegInt.default(0).describe('Number of items to skip (0-based).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum number of items to return (1-200).'),
} as const;

/**
 * 1-based page pagination shape (`page_num` / `page_size`). `page_num`
 * defaults to 1, `page_size` is bounded `1..200` and defaults to 50.
 * Mirrors onehome-mcp's search pagination, normalized to 1-based.
 */
export const pageSchema = {
  page_num: PositiveInt.default(1).describe('1-based page number.'),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Number of items per page (1-200).'),
} as const;

/**
 * Convert a 1-based page + page size into a zero-based offset.
 *
 * Defensive against bad callers: page and size are floored, page is clamped to
 * `>= 1` and size to `>= 0`, so the result is always a non-negative integer.
 *
 * @example calculateOffset(1, 50) // 0
 * @example calculateOffset(3, 50) // 100
 */
export function calculateOffset(page: number, size: number): number {
  const p = Math.max(1, Math.floor(page));
  const s = Math.max(0, Math.floor(size));
  return (p - 1) * s;
}

// ---------------------------------------------------------------------------
// Tool annotations
// ---------------------------------------------------------------------------

/** The MCP tool-annotation block, as consumed by `server.registerTool`. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Options for {@link toolAnnotations}. */
export interface ToolAnnotationsInput {
  /** Human-readable tool title (shown in clients). Omitted from output when unset. */
  title?: string;
  /** Tool does not modify state. Default `true` (most fleet tools are reads). */
  readOnly?: boolean;
  /** Repeated identical calls have the same effect. Emitted ONLY when set. */
  idempotent?: boolean;
  /**
   * Tool reaches an open/unbounded external world (the live web/API) rather
   * than a closed local computation. Emitted ONLY when set.
   */
  openWorld?: boolean;
}

/**
 * Build the `annotations` block for `server.registerTool`. Only `readOnlyHint`
 * is always emitted (defaulting to `true` — most fleet tools are reads); `title`,
 * `idempotentHint`, and `openWorldHint` are emitted ONLY when you pass them. This
 * makes it a clean drop-in for the common `{ readOnlyHint: true }` shape without
 * injecting hints a tool didn't declare.
 *
 * @example toolAnnotations({ title: 'Search properties' })  // { title, readOnlyHint: true }
 * @example toolAnnotations({ readOnly: false })             // { readOnlyHint: false }
 * @example toolAnnotations({ title: 'Search', idempotent: true, openWorld: true })
 *   // { title, readOnlyHint: true, idempotentHint: true, openWorldHint: true }
 */
export function toolAnnotations(opts: ToolAnnotationsInput = {}): ToolAnnotations {
  return {
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    readOnlyHint: opts.readOnly ?? true,
    ...(opts.idempotent !== undefined ? { idempotentHint: opts.idempotent } : {}),
    ...(opts.openWorld !== undefined ? { openWorldHint: opts.openWorld } : {}),
  };
}

// ---------------------------------------------------------------------------
// Time normalization (resy)
// ---------------------------------------------------------------------------

/**
 * Extract bare `HH:MM` from an ISO-ish datetime such as
 * `2026-05-01T19:00:00` or a wire time `19:00:00`. Deliberately avoids
 * `new Date()` so times aren't shifted by the server's timezone (resy returns
 * restaurant-local times with no offset). Returns `''` when no time is found.
 *
 * @example extractTime('2026-05-01T19:30:00') // '19:30'
 * @example extractTime('19:30:00')            // '19:30'
 * @example extractTime(undefined)             // ''
 */
export function extractTime(input: string | undefined | null): string {
  if (!input) return '';
  // Prefer the time component after a `T`; fall back to a leading HH:MM[:SS].
  const afterT = /T(\d{2}):(\d{2})/.exec(input);
  if (afterT) return `${afterT[1]}:${afterT[2]}`;
  const leading = /^(\d{2}):(\d{2})/.exec(input);
  return leading ? `${leading[1]}:${leading[2]}` : '';
}

/**
 * Normalize a loose caller-supplied time to canonical 24-hour `HH:MM`.
 *
 * Accepts:
 *  - `HH:MM` / `H:MM`           → zero-padded `HH:MM`
 *  - `HH:MM:SS`                 → seconds trimmed
 *  - `7pm`, `7:30 PM`, `12 am`  → 12h clock converted (12am→00, 12pm→12)
 *
 * Returns `undefined` when the input can't be understood, so callers can fall
 * through to a default rather than book at a garbage time.
 *
 * @example normalizeTime('7:30 PM') // '19:30'
 * @example normalizeTime('9:5')     // '09:05'
 * @example normalizeTime('12am')    // '00:00'
 * @example normalizeTime('nope')    // undefined
 */
export function normalizeTime(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  const s = input.trim().toLowerCase();
  if (!s) return undefined;

  const m = /^(\d{1,2})(?::(\d{1,2}))?(?::\d{1,2})?\s*(am|pm)?$/.exec(s);
  if (!m) return undefined;

  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3];

  if (minute > 59) return undefined;

  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return undefined;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export * from './parse-lenient.js';
