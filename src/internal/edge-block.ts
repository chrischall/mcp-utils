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

/**
 * Whether a RESPONSE a request function handed back is a CDN/WAF refusal —
 * read by the session managers before they spend a refresh or a re-login on
 * it (chrischall/mcp-host#1015). Accepts a web `Response` (its body is read
 * from a `clone()`, so the caller's copy stays readable; a JSON body is never
 * read, since no refusal page is JSON) or any `{ status, body: string,
 * headers? }` shape such as `@fetchproxy/server`'s `HttpResponse`. Only a
 * 4xx/5xx is judged; anything else, or anything unreadable, is "not shown to
 * be a block".
 */
export async function responseEdgeBlock(res: unknown): Promise<{ vendor: string } | null> {
  const r = objectField(res) as
    | { status?: unknown; body?: unknown; headers?: unknown; clone?: unknown }
    | undefined;
  if (r === undefined || typeof r.status !== 'number' || r.status < 400) return null;
  const status = r.status;
  const headers = objectField(r.headers) as EdgeBlockHeaders | undefined;
  const withHeaders = headers !== undefined ? { headers } : {};
  if (typeof r.body === 'string') return detectEdgeBlock({ body: r.body, status, ...withHeaders });
  const byHeaders = detectEdgeBlock({ status, ...withHeaders });
  if (byHeaders !== null || typeof r.clone !== 'function') return byHeaders;
  const contentType = headers !== undefined && typeof (headers as Headers).get === 'function'
    ? ((headers as Headers).get('content-type') ?? '')
    : '';
  if (/json/i.test(contentType)) return null;
  let body = '';
  try {
    body = await (r.clone as () => { text: () => Promise<string> }).call(res).text();
  } catch {
    return null;
  }
  return detectEdgeBlock({ body, status, ...withHeaders });
}
