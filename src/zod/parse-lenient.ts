/**
 * `parseLenient` — the fleet's degrade-never-break validator for undocumented
 * / reverse-engineered APIs.
 *
 * Consolidates the near-verbatim triplets `parseAllTrails` (alltrails),
 * `parseOFW` (ofw), and `parseGYG` (getyourguide), plus the inline variants in
 * viator's `compactProductsEnvelope` and tripadvisor's `compactList`: validate
 * an upstream response against a LOOSE schema covering only the fields you
 * read; when the shape drifts, warn to stderr (never stdout — it's reserved
 * for JSON-RPC) with the precise issues and return the RAW response, so `??`
 * fallbacks keep working and the tool degrades instead of breaking.
 */

import type { ZodType } from 'zod';

import { McpToolError } from '../errors/index.js';

/** Options for {@link parseLenient}. */
export interface ParseLenientOptions {
  /** Log prefix, conventionally the server name (e.g. `'viator-mcp'`). */
  label: string;
  /** What was being parsed, for the warning/error copy (e.g. `'search response'`). */
  context: string;
  /**
   * `'lenient'` (default): on mismatch, warn to stderr and return the raw
   * value. `'strict'`: throw an {@link McpToolError} — for write paths where
   * proceeding on a drifted shape could corrupt something.
   */
  mode?: 'lenient' | 'strict';
}

/**
 * Validate `raw` against `schema`. On success returns the parsed data (with
 * schema defaults/coercions applied). On failure:
 *  - lenient mode logs `[label] WARNING: unexpected <context> shape …` with the
 *    issue paths to stderr and returns `raw` **as-is** (typed as the schema
 *    output for ergonomics — treat drifted fields defensively);
 *  - strict mode throws an {@link McpToolError} naming the context.
 */
export function parseLenient<T>(
  schema: ZodType<T>,
  raw: unknown,
  opts: ParseLenientOptions,
): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  const issues = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

  if (opts.mode === 'strict') {
    throw new McpToolError(`Unexpected ${opts.context} shape from the upstream API. ${issues}`, {
      hint: 'The upstream API may have changed; the schema needs updating.',
    });
  }

  console.error(
    `[${opts.label}] WARNING: unexpected ${opts.context} shape — proceeding with the raw response. ${issues}`,
  );
  return raw as T;
}
