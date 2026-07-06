import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { redactSecrets } from '../errors/index.js';

/**
 * Wrap any JSON-serialisable value as an MCP tool result. This is the single
 * most duplicated snippet across the fleet:
 *   `{ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }`
 */
export function textResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/** Alias for {@link textResult} — pretty-printed JSON tool result. */
export const jsonResult = textResult;

/** Return a raw string as a text tool result (no JSON stringify). */
export function rawTextResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Return a base64 image as an MCP image tool result. */
export function imageResult(base64: string, mimeType: string): CallToolResult {
  return {
    content: [{ type: 'image', data: base64, mimeType }],
  };
}

/**
 * Return an error tool result (`isError: true`) carrying a message. The message
 * is run through {@link redactSecrets} so `errorResult(String(err))` can't leak
 * tokens/cookies an upstream error carries — redaction only, never truncated.
 */
export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: redactSecrets(message) }],
    isError: true,
  };
}

/**
 * Collapse a JSON:API-shaped payload (`{ data: { id, type, attributes } }` or an
 * array thereof) into plain objects with `id`/`type` merged into attributes.
 * Used by skylight-mcp; opt-in (callers pass payloads they know are JSON:API).
 */
export function flattenJsonApi(payload: unknown): unknown {
  const flattenOne = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const attrs = obj.attributes;
    if (attrs !== null && typeof attrs === 'object') {
      const merged: Record<string, unknown> = { ...(attrs as Record<string, unknown>) };
      if ('id' in obj) merged.id = obj.id;
      if ('type' in obj) merged.type = obj.type;
      return merged;
    }
    return node;
  };

  if (payload === null || typeof payload !== 'object') return payload;
  const root = payload as Record<string, unknown>;
  if (!('data' in root)) return payload;
  const data = root.data;
  if (Array.isArray(data)) return data.map(flattenOne);
  return flattenOne(data);
}

/**
 * Recursively rewrite every occurrence of a named **string** field in a parsed
 * JSON value, in place, returning the same value. Non-string values of that key
 * and all other keys are left untouched. Handy for normalizing a date/format
 * field out of an API response, e.g.
 * `deepMapStringField(data, 'eventDate', dmyToIso)`.
 */
export function deepMapStringField<T>(value: T, field: string, map: (v: string) => string): T {
  if (Array.isArray(value)) {
    for (const item of value) deepMapStringField(item, field, map);
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (key === field && typeof v === 'string') obj[key] = map(v);
      else deepMapStringField(v, field, map);
    }
  }
  return value;
}

/**
 * Shallow-copy an object, dropping every `undefined`-valued key. `null` and
 * falsy values survive — only `undefined` means "not provided".
 *
 * Consolidates the byte-identical `compact()` (skylight) / `prune()` (viator /
 * alltrails) helpers the compact-projection tools call dozens of times per repo.
 */
export function pruneUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/**
 * Coerce a maybe-array to an array: an array passes through (same reference), a
 * bare value is wrapped, and `null`/`undefined` become `[]`.
 *
 * Consolidates the `toArray` twins in canvas-parent / infinitecampus — both
 * guard XML→JSON serializers where a single item arrives as a bare object
 * rather than a 1-element array.
 */
export function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
