/**
 * A request that never got a response, said in a way someone can act on.
 *
 * Node's `fetch` (undici) reports every transport failure — DNS, a refused or
 * reset connection, a TLS certificate it will not trust, an egress proxy that
 * refused the tunnel — as the same `TypeError('fetch failed')`, with the real
 * reason on its `cause` chain. Surfaced as is, that reads "Failed to get the
 * attachment: fetch failed", which names neither the host nor the reason.
 *
 * Lifted from microsoft-teams-mcp `src/network-error.ts` (the reference: three
 * Teams clients use it), for office-outlook-mcp and every other direct-fetch
 * server whose users still saw a bare "fetch failed" —
 * chrischall/fleet-audit#1306. The message names the HOST (never the path or
 * query, which may carry ids or signatures) and the cause's code; the hint is
 * keyed to that code, and a server can reword any class of it.
 *
 * Zero dependencies beyond the core `errors` module.
 */
import { McpToolError } from '../errors/index.js';

/** How far down a cause chain (and into an AggregateError) to look for a code. */
const MAX_CAUSE_DEPTH = 5;

const DNS_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);

const CONNECT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

const CERT_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function codeOf(e: unknown): string | undefined {
  if (e === null || typeof e !== 'object') return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

/** The causes to look at, nearest first: the cause chain, and an AggregateError's members. */
function causes(err: unknown): unknown[] {
  const out: unknown[] = [];
  let at: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && at !== undefined && at !== null; depth++) {
    out.push(at);
    if (at instanceof AggregateError) out.push(...at.errors);
    at = (at as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * The first system / undici error `code` (a non-empty string) on `err`'s cause
 * chain — `ENOTFOUND`, `ECONNRESET`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, … —
 * looking inside an `AggregateError` (both address families refused) too, and
 * at most five links deep (a cyclic chain terminates). `undefined` when none.
 */
export function transportCauseCode(err: unknown): string | undefined {
  for (const e of causes(err)) {
    const code = codeOf(e);
    if (code !== undefined) return code;
  }
  return undefined;
}

/** The innermost cause's message, which is where undici puts the real reason. */
function causeMessage(err: unknown): string | undefined {
  const chain = causes(err).slice(1);
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = chain[i];
    if (e instanceof Error && e.message !== '') return e.message;
  }
  return undefined;
}

/**
 * Whether `err` is `fetch`'s "never got a response" failure: exactly a
 * `TypeError` whose message is `fetch failed`. A `TypeError('Invalid URL')`
 * (the request was never made) is not one.
 */
export function isFetchFailedError(err: unknown): boolean {
  return err instanceof TypeError && err.message === 'fetch failed';
}

/**
 * The status a configured HTTPS proxy answered the CONNECT with, when that is
 * why the request failed. undici reports it only in the message of an
 * `UND_ERR_ABORTED` cause ("Proxy response (403) !== 200 when HTTP
 * Tunneling") — there is no structured field to branch on — and Node's own
 * http proxy support uses code `ERR_PROXY_TUNNEL`.
 */
function proxyRefusalStatus(err: unknown): number | 'unknown' | undefined {
  for (const e of causes(err)) {
    if (codeOf(e) === 'ERR_PROXY_TUNNEL') {
      const m = /\b(\d{3})\b/.exec(e instanceof Error ? e.message.slice(0, 500) : '');
      return m ? Number(m[1]) : 'unknown';
    }
    if (e instanceof Error) {
      const m = /^Proxy response \((\d{3})\) !== 200 when HTTP Tunneling/.exec(e.message);
      if (m) return Number(m[1]);
    }
  }
  return undefined;
}

/**
 * Which kind of transport failure a hint is for:
 *
 *  - `'egress'` — an outbound proxy refused the destination by policy (it
 *    answered the CONNECT with 403 / 407): on mcp-host, the registration's
 *    egress allow-list;
 *  - `'proxy'` — an outbound proxy could not open the tunnel for some other
 *    reason (it answered, say, 502);
 *  - `'dns'` — the host did not resolve;
 *  - `'tls'` — Node did not trust the certificate the host presented;
 *  - `'connect'` — the connection was refused, reset or timed out;
 *  - `'other'` — none of the above could be told apart.
 */
export type TransportFailureClass = 'egress' | 'proxy' | 'dns' | 'tls' | 'connect' | 'other';

/** What a {@link TransportFailureHints} entry is told. */
export interface TransportFailureHintContext {
  /** The host the request was for (never its path or query). */
  host: string;
  /** The service name passed to {@link describeTransportFailure}. */
  service: string;
  /** The cause's code, when one was found. */
  code: string | undefined;
  /** For `'proxy'` / `'egress'`: the status the proxy answered with, or `'unknown'`. */
  proxyStatus?: number | 'unknown';
}

/** Per-class rewording of {@link describeTransportFailure}'s hint. Each entry replaces the default for its class. */
export type TransportFailureHints = Partial<Record<TransportFailureClass, (host: string, ctx: TransportFailureHintContext) => string>>;

/** Options for {@link describeTransportFailure}. */
export interface DescribeTransportFailureOptions {
  /**
   * Reword the hint for one or more classes — e.g. microsoft-teams-mcp's DNS
   * hint names the regional `*.asm.skype.com` / `*.sharepoint.com` hosts a
   * split-tunnel VPN fails to resolve. Classes not given keep the default.
   */
  hints?: TransportFailureHints;
}

/** The class of a `fetch failed` error, and the proxy status when a proxy is why. */
function classify(err: unknown, code: string | undefined): { cls: TransportFailureClass; proxyStatus?: number | 'unknown' } {
  const refused = proxyRefusalStatus(err);
  if (refused !== undefined) {
    return { cls: refused === 403 || refused === 407 || refused === 'unknown' ? 'egress' : 'proxy', proxyStatus: refused };
  }
  if (code !== undefined && DNS_CODES.has(code)) return { cls: 'dns' };
  if (code !== undefined && CERT_CODES.has(code)) return { cls: 'tls' };
  if (code !== undefined && CONNECT_CODES.has(code)) return { cls: 'connect' };
  return { cls: 'other' };
}

const DEFAULT_HINTS: Required<TransportFailureHints> = {
  egress: (host) =>
    `The outbound proxy this server runs behind refused the connection to ${host}: its egress ` +
    'policy does not allow that host. On a hosted (mcp-host) registration, the host must be on the ' +
    "registration's egress allow-list — the owner accepts the manifest's egress proposal (or adds " +
    'the host) on the registration, then retries. Elsewhere, ask whoever runs the proxy to allow it.',
  proxy: (host, ctx) =>
    `The outbound proxy this server runs behind could not open a connection to ${host} ` +
    `(it answered ${String(ctx.proxyStatus)}). Retry; if it persists, check the proxy can reach the host.`,
  dns: (host) =>
    `This machine could not resolve ${host}. Check DNS and VPN: a split-tunnel VPN that resolves ` +
    "some of a service's hosts but not others fails exactly like this. " +
    `\`nslookup ${host}\` on the machine running this server tells you which.`,
  tls: (host) =>
    `Node did not trust the TLS certificate ${host} presented. On a corporate network this is ` +
    "usually TLS inspection: export your proxy's root CA as PEM and start this server with " +
    'NODE_EXTRA_CA_CERTS=/path/to/ca.pem (Node does not read the system keychain). If the ' +
    "certificate is expired or not yet valid, also check the machine's clock.",
  connect: (host, ctx) =>
    `The connection to ${host} was refused, reset or timed out before ${ctx.service} answered — usually a ` +
    "firewall, or a network that only lets traffic out through a proxy. Node's fetch ignores " +
    'proxy settings unless told: start this server with HTTPS_PROXY=<your proxy URL> and ' +
    'NODE_USE_ENV_PROXY=1 (Node 22.21+ / 24.5+), or allow the host through the firewall.',
  other: (host) =>
    `No response from ${host}. Check this machine can reach it (VPN, proxy, firewall); ` +
    `\`curl -sI https://${host}/\` from the same machine is a quick test.`,
};

/**
 * An {@link McpToolError} (`kind: 'transport'`) describing `err` when it is
 * `fetch`'s transport failure ({@link isFetchFailedError}) for `url`, else
 * `undefined` — the caller rethrows `err` as it was:
 *
 * ```ts
 * try {
 *   return await fetch(url, init);
 * } catch (e) {
 *   throw describeTransportFailure(e, url, 'Outlook') ?? e;
 * }
 * ```
 *
 * The message is `Could not reach <service> at <host> (<code>: <cause message>).`
 * — the host only, never the path or query. The hint is keyed to the
 * {@link TransportFailureClass}: an egress-proxy refusal points at the
 * registration's allow-list (not at DNS or the VPN), DNS at `nslookup`, TLS at
 * `NODE_EXTRA_CA_CERTS`, a refused/reset connection at `HTTPS_PROXY` +
 * `NODE_USE_ENV_PROXY=1`, anything else at a `curl -sI` check. Reword any class
 * with `opts.hints`. The original error is chained as `cause`.
 */
export function describeTransportFailure(
  err: unknown,
  url: string,
  service: string,
  opts: DescribeTransportFailureOptions = {},
): McpToolError | undefined {
  if (!isFetchFailedError(err)) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = '(unknown host)';
  }
  const code = transportCauseCode(err);
  const detail = [code, causeMessage(err)].filter((s): s is string => s !== undefined);
  const why = detail.length > 0 ? ` (${[...new Set(detail)].join(': ')})` : '';
  const { cls, proxyStatus } = classify(err, code);
  const ctx: TransportFailureHintContext = { host, service, code, ...(proxyStatus !== undefined ? { proxyStatus } : {}) };
  const hint = (opts.hints?.[cls] ?? DEFAULT_HINTS[cls])(host, ctx);
  return new McpToolError(`Could not reach ${service} at ${host}${why}.`, { kind: 'transport', hint, cause: err });
}
