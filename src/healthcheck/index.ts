/**
 * `@chrischall/mcp-utils/healthcheck` — the credential-style healthcheck
 * factory.
 *
 * It lives in its OWN subpath rather than beside the bridge factory in
 * `/fetchproxy` because that module imports `@fetchproxy/server`, an optional
 * peer. Most connectors this helper is for — API-key and OAuth ones like
 * splitwise, gemini and freshbooks — have no fetchproxy dependency at all, and
 * importing it from `/fetchproxy` failed at runtime with
 * `Cannot find package '@fetchproxy/server'`. Nothing here touches fetchproxy.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { truncateErrorMessage, messageOf } from '../errors/index.js';

/**
 * Ladder arms for {@link registerCredentialHealthcheckTool}. Ordered by the
 * question each answers: is there a credential at all, did the far side accept
 * it, and did the round-trip work.
 */
export type CredentialHealthcheckArm =
  | 'ok'
  | 'no_credential'
  | 'credential_rejected'
  | 'timeout'
  | 'http'
  | 'transport'
  | 'unknown';

/** What a consumer's resolver reports. NEVER the credential value itself. */
export interface CredentialState {
  /**
   * Which source supplied the credential — `'env'`, `'fetchproxy'`, `'cache'`,
   * a connector field name, etc. `null` means nothing resolved, which short-
   * circuits the probe.
   */
  source: string | null;
  /**
   * Non-secret facts worth reporting: age, expiry, account label, which
   * district was selected. This is echoed into the tool result verbatim, so
   * it MUST NOT carry the credential, any part of it, or anything that would
   * identify it beyond a label — a healthcheck is the tool people paste into
   * chats when something is broken.
   */
  detail?: Record<string, unknown>;
}

/**
 * Options for {@link registerCredentialHealthcheckTool} — the credential-side
 * twin of `RegisterBridgeHealthcheckToolArgs` (in `../fetchproxy/`; not an
 * `{@link}` because this module deliberately cannot import that one). The per-connector bits are
 * `prefix`, `hostLabel`, the optional `probePath`, and the two functions that
 * reach the outside world (`resolveCredential`, `probeFn`).
 */
export interface RegisterCredentialHealthcheckToolArgs {
  /**
   * The `McpServer` to register the tool on — the same type
   * `RegisterBridgeHealthcheckToolArgs` takes. NOT a structural
   * `{ registerTool }` shape: `McpServer.registerTool` is generic over its
   * schema arguments, so a loose signature with `config: unknown` is not
   * assignable from the real method and every caller fails to typecheck.
   */
  server: McpServer;
  /** Tool-name prefix; the tool is `${prefix}_healthcheck`. */
  prefix: string;
  /** Display host for the probe URL and hint copy, e.g. `'api.freshbooks.com'`. */
  hostLabel: string;
  /** Optional path, for display only: the probe URL is `https://<hostLabel><probePath>`. */
  probePath?: string;
  /**
   * Resolve the credential the way the real tools do — same cache, same
   * fallback order — so a passing healthcheck means real tools work. Throwing
   * is treated as `no_credential` with the throw's message, because a resolver
   * that cannot produce one has answered the question.
   */
  resolveCredential: () => Promise<CredentialState>;
  /** One authenticated round-trip. Only called when a credential resolved. */
  probeFn: () => Promise<unknown>;
  /**
   * Classify a thrown error into an arm, and optionally override the hint and
   * carry structured detail. Consulted for a `probeFn` failure AND for a
   * `resolveCredential` failure.
   *
   * The resolver case is the one worth knowing about: a resolver fails for
   * reasons that are not "no credential" — a browser bridge that is down, an
   * upstream that rejected a password, a store that will not decrypt — and
   * without a classification all of those answer with the `no_credential`
   * arm's advice, which tells someone to set variables that are already set.
   * Returning `undefined` (or omitting this) keeps that fallback.
   *
   * A classification never changes `credential.resolved`: nothing resolved
   * either way, and the classification explains why.
   */
  classifyThrown?: (
    err: unknown,
  ) => { kind: string; hint?: string; detail?: Record<string, unknown> } | undefined;
  /** Per-arm copy overrides. */
  hints?: Partial<Record<CredentialHealthcheckArm, string>>;
}

/**
 * The JSON body `${prefix}_healthcheck` returns for a credential-style
 * connector, mirroring `BridgeHealthcheckResult`'s envelope: `ok`, the
 * per-subject block (here `credential` rather than `bridge`), the `probe`
 * measurements, an optional typed `error`, and always a human-readable `hint`.
 *
 * `credential` never carries the credential itself — only the source label and
 * whatever non-secret `detail` the resolver chose to report.
 */
export interface CredentialHealthcheckResult {
  ok: boolean;
  credential: { source: string | null; resolved: boolean; detail?: Record<string, unknown> };
  probe: { url?: string; elapsed_ms: number; status?: number };
  error?: { kind: string; message: string; detail?: Record<string, unknown> };
  hint: string;
}

/** HTTP status off a thrown error, when the thrower attached one. */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const s = (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  return typeof s === 'number' ? s : undefined;
}

function credentialHint(
  arm: CredentialHealthcheckArm,
  prefix: string,
  hostLabel: string,
  source: string | null,
): string {
  switch (arm) {
    case 'ok':
      return `Credential from '${source}' works: ${hostLabel} accepted an authenticated request. If a real tool still fails, the problem is that tool, not auth.`;
    case 'no_credential':
      return `No credential resolved. Nothing was available to authenticate with — sign in and reconnect the connector so ${prefix} receives a token, or set the documented environment variable.`;
    case 'credential_rejected':
      return `${hostLabel} rejected the credential from '${source}'. It is present but no longer valid — most often expired or revoked upstream. Re-authenticate and reconnect; retrying will not fix it.`;
    case 'timeout':
      return `The credential from '${source}' resolved, but ${hostLabel} did not answer in time. Usually transient — retry. If it persists, ${hostLabel} is slow or unreachable from here.`;
    case 'http':
      return `${hostLabel} answered with an error status that is not an auth rejection. That is USUALLY a ${hostLabel}-side problem rather than an auth one — but a 404 here more often means the probe path is wrong than that ${hostLabel} is broken, so check error.message and probe.url before concluding anything about the credential.`;
    case 'transport':
      return `Could not reach ${hostLabel} at all. Check network egress; the credential itself was never judged.`;
    default:
      return `Unexpected failure — see error.message.`;
  }
}

/**
 * Register `${prefix}_healthcheck` for a connector whose health is about a
 * CREDENTIAL rather than a browser bridge — OAuth connectors, API-key
 * connectors, and the fetchproxy MCPs that only BOOTSTRAP a token and then
 * talk to an API directly.
 *
 * It exists because those three failures are indistinguishable today and have
 * different fixes: nothing minted a credential, something minted one the far
 * side rejects, and the far side is simply down. The bridge helper
 * (`registerBridgeHealthcheckTool`, in `../fetchproxy/`) answers the equivalent question for
 * MCPs where every request rides the bridge.
 *
 * The probe is SKIPPED when no credential resolved — probing without one
 * produces a 401 that reads like a rejected credential and points at the wrong
 * fix.
 */
export function registerCredentialHealthcheckTool(
  args: RegisterCredentialHealthcheckToolArgs,
): void {
  const { server, prefix, hostLabel, probePath, resolveCredential, probeFn, classifyThrown, hints } =
    args;
  const probeUrl = probePath ? `https://${hostLabel}${probePath}` : undefined;

  server.registerTool(
    `${prefix}_healthcheck`,
    {
      title: 'Verify credentials and upstream reachability',
      description:
        `Resolves the credential the way real tools do, then makes one authenticated request to ${hostLabel}. Reports which source supplied the credential, whether ${hostLabel} accepted it, the round-trip time, and a plain-English hint distinguishing 'no credential' from 'credential rejected' from 'a ${hostLabel}-side problem'. Call this when a real tool fails and you want to know which hop broke. Read-only; never returns the credential itself.`,
      annotations: {
        title: 'Verify credentials and upstream reachability',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      // Timed from just BEFORE the probe, never from the top: resolving a
      // credential can mint a token or drive the browser bridge, and folding
      // that into `probe.elapsed_ms` reports it as far-side latency.
      let probeStarted = 0;

      let state: CredentialState;
      try {
        state = await resolveCredential();
      } catch (e) {
        // A resolver can fail for reasons that are NOT "no credential": a
        // browser bridge that is down, an upstream that rejected a password,
        // a store that will not decrypt. Flattening those into
        // `no_credential` hands out that arm's advice — set the variables —
        // to someone whose variables are already set. So the consumer's
        // classifier is consulted here as it already is for a probe failure;
        // declining it (or not supplying one) keeps the old behaviour exactly.
        const classified = classifyThrown?.(e);
        const result: CredentialHealthcheckResult = {
          ok: false,
          // Still false, and still no source: a classification explains WHY
          // nothing resolved, it does not invent a credential that did.
          credential: { source: null, resolved: false },
          // No `url`: nothing was probed, and naming one implies it was tried.
          probe: { elapsed_ms: 0 },
          error: {
            kind: classified?.kind ?? 'no_credential',
            message: truncateErrorMessage(messageOf(e)),
            ...(classified?.detail !== undefined ? { detail: classified.detail } : {}),
          },
          hint:
            classified?.hint ??
            hints?.no_credential ??
            credentialHint('no_credential', prefix, hostLabel, null),
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      }

      const credential = {
        source: state.source,
        resolved: state.source !== null,
        ...(state.detail !== undefined ? { detail: state.detail } : {}),
      };

      // No credential: answer without probing. A probe here 401s and reads as
      // "rejected", which points at re-authenticating a credential that does
      // not exist.
      if (!credential.resolved) {
        const result: CredentialHealthcheckResult = {
          ok: false,
          credential,
          probe: { elapsed_ms: 0 },
          error: { kind: 'no_credential', message: 'no credential source resolved' },
          hint: hints?.no_credential ?? credentialHint('no_credential', prefix, hostLabel, null),
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      }

      let arm: CredentialHealthcheckArm = 'ok';
      let error: CredentialHealthcheckResult['error'];
      let status: number | undefined;
      let customHint: string | undefined;

      probeStarted = Date.now();
      try {
        await probeFn();
      } catch (e) {
        status = statusOf(e);
        // `AbortError` is matched on `err.name`, as src/http/index.ts does — a
        // bare AbortController abort carries it there and NOT in the message,
        // so matching the text alone classified those as 'unknown'.
        const aborted = e instanceof Error && e.name === 'AbortError';
        arm =
          status === 401 || status === 403
            ? 'credential_rejected'
            : status !== undefined
              ? 'http'
              : aborted || /timeout|timed out|ETIMEDOUT/i.test(messageOf(e))
                ? 'timeout'
                : /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|network/i.test(messageOf(e))
                  ? 'transport'
                  : 'unknown';
        let kind: string = arm;
        let detail: Record<string, unknown> | undefined;
        const custom = classifyThrown?.(e);
        if (custom) {
          kind = custom.kind;
          customHint = custom.hint;
          detail = custom.detail;
        }
        error = {
          kind,
          // Redacted AND bounded before it reaches the result: an upstream
          // failure routinely quotes what it was sent, and a healthcheck is
          // the tool people paste into a chat when something is broken.
          message: truncateErrorMessage(messageOf(e)),
          ...(detail !== undefined ? { detail } : {}),
        };
      }

      const result: CredentialHealthcheckResult = {
        ok: error === undefined,
        credential,
        probe: {
          ...(probeUrl ? { url: probeUrl } : {}),
          elapsed_ms: Date.now() - probeStarted,
          ...(status !== undefined ? { status } : {}),
        },
        ...(error ? { error } : {}),
        hint: customHint ?? hints?.[arm] ?? credentialHint(arm, prefix, hostLabel, state.source),
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

