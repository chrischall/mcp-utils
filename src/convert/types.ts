/**
 * Shared types and default limits for `@chrischall/mcp-utils/convert`.
 *
 * Every converter returns a {@link ConvertResult}: model-readable parts (text
 * or images) plus human-readable `notes`. Truncation is never silent — any cap
 * that bites sets `truncated` on the part and/or pushes a note.
 */

/** How to convert: `'auto'` picks per format, `'text'` / `'images'` force one. */
export type ConvertMode = 'auto' | 'text' | 'images';

/** The attachment formats this module can turn into model-readable content. */
export type ConvertibleFormat = 'pdf' | 'xlsx' | 'pptx';

/** One piece of converted output: a text document or an image. */
export type ConvertedPart =
  | { type: 'text'; name: string; mimeType: 'text/markdown' | 'text/csv'; text: string; truncated?: boolean }
  | { type: 'image'; name: string; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: Uint8Array };

/** The outcome of converting one attachment. */
export interface ConvertResult {
  format: ConvertibleFormat;
  parts: ConvertedPart[];
  /** Human-readable notes: what was cut, skipped or degraded and why (e.g. "pages 11–40 not rendered", "page images unavailable: @napi-rs/canvas is not installed"). */
  notes: string[];
  /** Pages / sheets / slides in the source, when known. */
  count?: number;
}

/** Caps applied to hostile input and to the size of the output. Every field is optional. */
export interface ConvertLimits {
  /** Total UTF-8 bytes across all text parts. Default {@link DEFAULT_CONVERT_LIMITS}`.maxTextBytes` (200 KiB). */
  maxTextBytes?: number;
  /** Most image parts returned. Default 10. */
  maxImages?: number;
  /** Total raw image bytes. Default 8 MiB (stays under mcp-host's 14 MiB result cap after base64). */
  maxImageBytes?: number;
  /** PDF pages / slides / sheets read at all. Default 100. */
  maxPages?: number;
  /** Refuse larger inputs. Default 50 MiB. */
  maxInputBytes?: number;
  /** Zip-bomb guard for xlsx/pptx: total inflated bytes. Default 200 MiB (and at most {@link ZIP_ENTRY_MAX_BYTES} per entry). */
  maxUnzippedBytes?: number;
}

/** {@link ConvertLimits} with every field filled. */
export type ResolvedConvertLimits = Required<ConvertLimits>;

const KiB = 1024;
const MiB = 1024 * KiB;

/** The defaults {@link resolveConvertLimits} fills in. */
export const DEFAULT_CONVERT_LIMITS: Readonly<ResolvedConvertLimits> = Object.freeze({
  maxTextBytes: 200 * KiB,
  maxImages: 10,
  maxImageBytes: 8 * MiB,
  maxPages: 100,
  maxInputBytes: 50 * MiB,
  maxUnzippedBytes: 200 * MiB,
});

/** Largest single zip entry inflated, whatever `maxUnzippedBytes` says (50 MiB). */
export const ZIP_ENTRY_MAX_BYTES = 50 * MiB;

/**
 * Fill unset (or non-finite / negative) limits with {@link DEFAULT_CONVERT_LIMITS}.
 * Explicit values are floored to integers.
 */
export function resolveConvertLimits(limits?: ConvertLimits): ResolvedConvertLimits {
  const out = { ...DEFAULT_CONVERT_LIMITS };
  for (const key of Object.keys(out) as Array<keyof ResolvedConvertLimits>) {
    const v = limits?.[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = Math.floor(v);
  }
  return out;
}
