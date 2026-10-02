/**
 * Which CDN/WAF, if any, a THROWN error says refused the request — shared by
 * the credential healthcheck (`healthcheck`) and the bridge healthcheck
 * (`fetchproxy`) so both judge a probe failure by one rule
 * (chrischall/mcp-host#1015). Deliberately NOT in `package.json#exports`:
 * the public rule is `detectEdgeBlock`; this is only how a healthcheck digs
 * the evidence out of whatever a consumer's client threw.
 */
import { messageOf } from '../errors/index.js';
import { EdgeBlockedError, detectEdgeBlock, type EdgeBlockHeaders } from '../http/index.js';

/** An object-typed field, or undefined. */
function objectField(value: unknown): object | undefined {
  return typeof value === 'object' && value !== null ? value : undefined;
}

/**
 * The edge vendor a thrown error says refused the request, if anything about
 * it does. An {@link EdgeBlockedError} says so outright; any other error is
 * judged on what it carries — its message (which is usually
 * `formatApiError`'s cut of the body), a `body`/`bodyPreview`/`responseBody`
 * string, a `headers` object, and a `response` object carrying
 * `status`/`body`/`headers` (the shape of `@fetchproxy/server`'s
 * `FetchproxyHttpError`, and of most HTTP libraries' errors) — by the same
 * {@link detectEdgeBlock} rule the API client uses, so a connector with its
 * own client is covered too.
 */
export function edgeBlockOf(err: unknown): { vendor: string } | null {
  if (err instanceof EdgeBlockedError) return { vendor: err.vendor };
  const e = objectField(err) as
    | { body?: unknown; bodyPreview?: unknown; responseBody?: unknown; headers?: unknown; response?: unknown }
    | undefined;
  if (e === undefined) return null;
  const response = objectField(e.response) as { status?: unknown; body?: unknown; headers?: unknown } | undefined;
  const parts = [messageOf(err), e.body, e.bodyPreview, e.responseBody, response?.body].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  const headers = (objectField(e.headers) ?? objectField(response?.headers)) as EdgeBlockHeaders | undefined;
  const status = statusOf(err) ?? statusOf(response);
  return detectEdgeBlock({
    body: parts.join('\n'),
    ...(headers !== undefined ? { headers } : {}),
    ...(status !== undefined ? { status } : {}),
  });
}

/** HTTP status off a thrown error (or its response), when one is attached. */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const s = (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  return typeof s === 'number' ? s : undefined;
}
