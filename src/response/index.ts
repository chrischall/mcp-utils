import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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

/** Return an error tool result (`isError: true`) carrying a message. */
export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
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
