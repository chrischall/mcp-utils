import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { stripMediaUrls } from './media.js';

/**
 * The fleet's response-shape vocabulary (`docs/fleet-conventions.md`,
 * "Response shape").
 *
 * Every tool that reads an upstream API answers in one of three shapes, and
 * the CHEAP one is the default. That inversion is the whole point: five repos
 * had already grown a projection by the time this was written, and four of
 * them made it opt-in — `compact: false` in the schema, with the tool's own
 * description asking the model to please pass `compact=true`. An efficiency
 * that has to be requested is one that is usually not, and the caller paying
 * for it is the one least able to know it was available.
 *
 * The rungs, in ascending order of size:
 *
 * - **compact** — the projection: the fields a caller acts on, with anything
 *   the response already carries elsewhere removed. The default.
 * - **full** — every field this MCP understands, nothing dropped.
 * - **raw** — the upstream payload, unprojected.
 *
 * `raw` means "no projection". It NEVER means "no normalisation": a repo that
 * rewrites values on the way out — timestamps into a single zone, ids into a
 * stable shape — keeps doing so on every rung. Handing back the untouched wire
 * format would reintroduce exactly the inconsistencies that normalisation
 * exists to remove, on the one rung a caller reaches for when something
 * already looks wrong.
 *
 * A tool registers only the rungs it can honour, so a schema never advertises
 * a value that would silently alias to another: `raw` is meaningless where a
 * record is ASSEMBLED from several endpoints rather than passed through from
 * one, and those tools offer `compact` and `full` alone.
 */
export const VIEWS = ['compact', 'full', 'raw'] as const;

/** One of {@link VIEWS}: the shape a read tool answers in. */
export type View = (typeof VIEWS)[number];

/** Efficiency is not something a caller should have to ask for. */
export const DEFAULT_VIEW: View = 'compact';

const BLURB: Record<View, string> = {
  compact: '"compact" (default) drops fields the response already carries elsewhere',
  full: '"full" returns every field this server understands',
  raw: '"raw" returns the upstream payload unprojected',
};

/** Per-tool tuning for {@link viewParam}. */
export interface ViewParamOptions {
  /**
   * What THIS tool's compact rung leaves out, in the tool's own words.
   *
   * Worth writing. The generic blurb says a projection happened; only the tool
   * can say which field a caller who needs it should ask for `full` to get.
   */
  note?: string;
}

/**
 * The `view` parameter, built from the rungs a tool actually honours.
 *
 * `view` rather than `detail`, `mode` or `compact`: `detail` is already an
 * UPSTREAM passthrough in alltrails-mcp (`basic|medium|offline` goes into the
 * URL), `mode` and `format` are taken elsewhere in the fleet, and `compact` as
 * a boolean cannot express three rungs — nor say whether `compact: false`
 * meant "everything you understand" or "everything you received".
 */
export function viewParam(honoured: readonly View[], opts: ViewParamOptions = {}): z.ZodOptional<z.ZodEnum<Record<string, string>>> {
  if (honoured.length < 2) {
    throw new Error('viewParam needs at least two rungs: a parameter offering one value decides nothing');
  }
  if (!honoured.includes('compact')) {
    // A tool whose rungs are `full` and `raw` has no cheap answer at all,
    // which is the shape this vocabulary exists to remove — not one it should
    // help express.
    throw new Error('viewParam must offer "compact": a tool with no cheap rung has nothing to default to');
  }
  const ordered = VIEWS.filter((v) => honoured.includes(v));
  const sentence = `Response shape: ${ordered.map((v) => BLURB[v]).join('; ')}.`;
  // `.describe()` LAST, after `.optional()`. Applied to the enum it lands on
  // the inner type, and the wrapper an MCP host actually reads its description
  // off comes back blank — a parameter documented to nobody.
  return z
    .enum(Object.fromEntries(ordered.map((v) => [v, v])))
    .optional()
    .describe(opts.note ? `${sentence} ${opts.note}` : sentence);
}

/**
 * The rung to answer in. Absent means `compact`.
 *
 * The schema has already rejected anything this tool does not honour, so this
 * is the second line — and it fails toward the CHEAP answer rather than
 * throwing, because a caller that somehow named an unavailable rung is better
 * served by a small correct response than by an error.
 */
export function resolveView(value: string | undefined, honoured: readonly View[]): View {
  return value !== undefined && (honoured as readonly string[]).includes(value) ? (value as View) : DEFAULT_VIEW;
}

/**
 * A tool result with no formatting whitespace.
 *
 * `JSON.stringify(data, null, 2)` — the fleet's most duplicated line — spends
 * roughly a fifth of a large response on indentation that carries no
 * information and that nothing downstream reads: measured at 23% of a
 * 135 KB ofw-mcp message page, or about 8,000 tokens per call.
 *
 * Only FORMATTING whitespace goes. Whitespace inside a value is content — the
 * blank line between paragraphs of a message body, the indentation of a quoted
 * block — and `JSON.stringify` leaves every byte of it alone, because it drops
 * only the indent and the runs after `:` and `,`. Any hand-rolled alternative
 * (a regex over the serialised text, a collapse of `\s+`) corrupts exactly the
 * payloads this is meant to shrink. There are tests on that; do not replace
 * this with something cleverer.
 *
 * Key ORDER is untouched too, which several repos depend on (ofw-mcp emits its
 * paging state before its data array precisely so a truncated read still sees
 * it).
 */
export function minifiedResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * A tool result whose whitespace matches its rung: `compact` and `full` are
 * minified, `raw` stays indented.
 *
 * The asymmetry is deliberate rather than an oversight. `compact` and `full`
 * are consumed by a model, which reads the parse and not the layout. `raw` is
 * the rung a person reaches for when a payload is not what they expected, and
 * indentation is most of what makes an unfamiliar shape legible.
 */
export function viewResult(view: View, data: unknown): CallToolResult {
  return view === 'raw' ? { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } : minifiedResult(data);
}

/** Who is projecting what, for the stderr line {@link projectOrRaw} writes on a fallback. */
export interface ProjectOptions {
  /** The MCP's own name, for the stderr line. */
  label: string;
  /** Which call produced the value — the endpoint, usually. */
  context: string;
}

/**
 * Project a value, falling back to the RAW value if the projection fails.
 *
 * This is what makes compact-by-default survivable on a reverse-engineered
 * API, and it is not optional. A projector names fields; upstream changes
 * them; and the two failure modes that follow are an exception (loud, but it
 * takes the whole tool call down) and an empty or half-filled record (silent,
 * and indistinguishable from "there was nothing there") — which is the same
 * false negative every absence-reporting guard in this fleet exists to
 * prevent. So a projector that throws, or that returns nothing, hands back
 * everything instead and says why on stderr.
 *
 * `undefined` counts as a failure. A projection legitimately has nothing to
 * say only about a value that was already absent, and a caller cannot tell
 * that from a projector that lost its footing.
 */
export function projectOrRaw<T, R>(value: T, project: (value: T) => R, opts: ProjectOptions): T | R {
  try {
    const projected = project(value);
    if (projected === undefined) {
      warn(opts, 'the projection produced nothing');
      return value;
    }
    return projected;
  } catch (error) {
    warn(opts, error instanceof Error ? error.message : String(error));
    return value;
  }
}

function warn(opts: ProjectOptions, why: string): void {
  console.error(
    `[${opts.label}] WARNING: could not project ${opts.context} (${why}); returning the unprojected payload. ` +
      'The upstream shape has probably changed — the projection needs updating.',
  );
}

// ---------------------------------------------------------------------------
// View composition — viewArg / viewResponse / createViewKit
// ---------------------------------------------------------------------------
//
// Consolidates the `src/view.ts` every compact-by-default read server grew on
// top of the primitives above (chrischall/fleet-audit#1348): viator-mcp (the
// reference — it already took an optional projector), tripadvisor-mcp,
// eventbrite-mcp and getyourguide-mcp (accessoticketing-mcp and alltrails-mcp
// carry the same rule inline). Each wrapped `viewParam` in a `viewArg(note)`
// and answered with `minifiedResult(project ? project(data) :
// stripMediaUrls(data))` on the compact rung, re-explaining the one rule worth
// keeping in a 30-line docblock five times over: **a hand-written projection
// is NOT then media-stripped.** A projection is written WITH knowledge of the
// API and may deliberately keep an image (viator's `compactProduct` keeps
// `coverImageUrl`); running a blind subtractive rule over its output lets an
// un-grounded rule overrule a grounded one (viator #72).

/** A tool's own field projection for its compact rung. */
export type ViewProjector = (data: unknown) => unknown;

/** Options for {@link viewResponse}. */
export interface ViewResponseOptions {
  /** The rungs this tool honours — the same list its {@link viewArg} offers. */
  views: readonly View[];
  /**
   * The tool's own field projection, run on the compact rung INSTEAD of
   * media stripping (never before it). Omit it and compact strips media URLs
   * ({@link stripMediaUrls}) and keeps every other field.
   */
  project?: ViewProjector;
}

/**
 * The `view` parameter a read tool takes: {@link viewParam} over the tool's
 * rungs, with `note` saying what THIS tool's compact rung keeps. A tool whose
 * compact rung is a field projection should pass its own note naming the
 * fields it keeps — a note describing a rung the tool does not have is worse
 * than a generic one, because the caller acts on it (viator-mcp's shared note
 * promised "no field projection" on two tools that ran one).
 */
export function viewArg(
  views: readonly View[],
  note?: string,
): z.ZodOptional<z.ZodEnum<Record<string, string>>> {
  return viewParam(views, note !== undefined ? { note } : {});
}

/**
 * Answer a read tool in the requested rung.
 *
 *  - `compact` (the default, and the fallback for a rung the tool does not
 *    honour — {@link resolveView}): `project(data)` when the tool has a
 *    projection, else `stripMediaUrls(data)`; minified.
 *  - `full`: `data` untouched, minified. The projector never runs.
 *  - `raw`: `data` untouched, indented ({@link viewResult}).
 *
 * Only ever for a READ tool: a write's response is a receipt — an id, a
 * status — with nothing to strip and everything to keep.
 */
export function viewResponse(view: string | undefined, data: unknown, opts: ViewResponseOptions): CallToolResult {
  const rung = resolveView(view, opts.views);
  if (rung !== 'compact') return viewResult(rung, data);
  return minifiedResult(opts.project ? opts.project(data) : stripMediaUrls(data));
}

/** What {@link createViewKit} returns: the two helpers, bound to one rung list. */
export interface ViewKit {
  /** The rungs every tool of this server honours. */
  readonly views: readonly View[];
  /** {@link viewArg} over {@link views}; `note` defaults to the kit's own. */
  viewArg(note?: string): z.ZodOptional<z.ZodEnum<Record<string, string>>>;
  /** {@link viewResponse} over {@link views}, with an optional projector. */
  viewResponse(view: string | undefined, data: unknown, project?: ViewProjector): CallToolResult;
}

/**
 * Bind {@link viewArg} and {@link viewResponse} to a server's rung list and
 * default note — the `view.ts` each donor exported, in one line:
 *
 * ```ts
 * export const { viewArg, viewResponse } = createViewKit(['compact', 'full'], {
 *   note: 'compact strips image URLs; "full" returns the payload untouched.',
 * });
 * ```
 *
 * The rung list is validated at construction ({@link viewParam}'s rules), so a
 * server cannot boot advertising a `view` it cannot honour.
 */
export function createViewKit(views: readonly View[], opts: { note?: string } = {}): ViewKit {
  viewParam(views); // validate once, at construction
  const fixed = [...views];
  return {
    views: fixed,
    viewArg: (note = opts.note) => viewArg(fixed, note),
    viewResponse: (view, data, project) =>
      viewResponse(view, data, { views: fixed, ...(project !== undefined ? { project } : {}) }),
  };
}
