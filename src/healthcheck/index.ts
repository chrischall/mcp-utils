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
  /** Credentials are fine; no session is live. See {@link sessionProbe}. */
  | 'session_expired'
  /** A second factor is outstanding, so the far side is holding the sign-in. */
  | 'verification_pending'
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
  /**
   * Optional path, for display only: the probe URL is
   * `https://<hostLabel>/<probePath>`, with the separator inserted only when
   * `probePath` does not already begin with one.
   */
  probePath?: string;
  /**
   * Resolve the credential the way the real tools do — same cache, same
   * fallback order — so a passing healthcheck means real tools work.
   *
   * Throwing reports the throw's message and `resolved: false`. The ARM is
   * `no_credential` by default — a resolver that cannot produce one has
   * answered the question — but {@link
   * RegisterCredentialHealthcheckToolArgs.classifyThrown} is consulted first,
   * so a resolver that failed for some other reason (a bridge that is down, a
   * rejected password) can say so instead of being told to set variables that
   * are already set.
   */
  resolveCredential: () => Promise<CredentialState>;
  /**
   * One authenticated round-trip. Only called when a credential resolved.
   *
   * **It reports failure only by THROWING.** A probe that resolves is reported
   * healthy, whatever it resolved to — so a 2xx is not, on its own, proof of a
   * session. A cookie-session portal answers a dead session with a login page
   * served 200, or a redirect to one; a probe that hands either back reports
   * `ok: true` and tells the caller to go debug a tool. {@link sessionProbe}
   * builds a compliant probe from the one closure only the consumer can write.
   */
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

const CREDENTIAL_ARMS = new Set<string>([
  'ok',
  'no_credential',
  'credential_rejected',
  'session_expired',
  'verification_pending',
  'timeout',
  'http',
  'transport',
  'unknown',
]);

/** True for a kind this module has copy for. A consumer may invent others. */
function isArm(kind: string | undefined): kind is CredentialHealthcheckArm {
  return kind !== undefined && CREDENTIAL_ARMS.has(kind);
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
    case 'session_expired':
      return `The credential from '${source}' is configured, but no session is live — ${hostLabel} served a sign-in page rather than the data. Sign in again; a cookie-session portal expires these on its own, so this recurs between uses.`;
    case 'verification_pending':
      return `${hostLabel} is holding the sign-in on a second factor rather than refusing it. Supply the verification code the ACCOUNT HOLDER received — the credential itself is not the problem, so changing it will not help.`;
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

/** The text result an MCP tool handler returns. */
export type HealthcheckToolResult = { content: { type: 'text'; text: string }[] };

/** The credential arm's one-line description, shared with the adaptive tool. */
export function credentialHealthcheckDescription(hostLabel: string): string {
  return `Resolves the credential the way real tools do, then makes one authenticated request to ${hostLabel}. Reports which source supplied the credential, whether ${hostLabel} accepted it, the round-trip time, and a plain-English hint distinguishing 'no credential' from 'credential rejected' from 'a ${hostLabel}-side problem'. Read-only; never returns the credential itself.`;
}

/**
 * The credential healthcheck's whole body, without the registration: what a
 * connector reports when its health is about a CREDENTIAL rather than a browser
 * bridge — OAuth connectors, API-key connectors, and the fetchproxy MCPs that
 * only BOOTSTRAP a token and then talk to an API directly.
 *
 * It exists because those three failures are indistinguishable today and have
 * different fixes: nothing minted a credential, something minted one the far
 * side rejects, and the far side is simply down. The bridge helper
 * ({@link runBridgeHealthcheck}, in `../fetchproxy/`) answers the equivalent
 * question for MCPs where every request rides the bridge.
 *
 * The probe is SKIPPED when no credential resolved — probing without one
 * produces a 401 that reads like a rejected credential and points at the wrong
 * fix.
 *
 * Split out from the registration so ONE tool can serve a server with two
 * transports and choose between the arms per call
 * (`registerAdaptiveHealthcheckTool`, in `../fetchproxy/`, which is where the
 * bridge arm's optional peer dependency already lives).
 * `registerCredentialHealthcheckTool` is unchanged and still the right choice
 * for a server with only this arm.
 */
export async function runCredentialHealthcheck(
  args: RegisterCredentialHealthcheckToolArgs,
): Promise<HealthcheckToolResult> {
  const { prefix, hostLabel, probePath, resolveCredential, probeFn, classifyThrown, hints } = args;
  const probeUrl = probePath
    ? `https://${hostLabel}${probePath.startsWith('/') ? '' : '/'}${probePath}`
    : undefined;
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
      // The hint must follow the KIND beside it. Falling back to
      // `no_credential`'s copy under a classified kind would state a cause
      // the kind contradicts — the same disagreement this path exists to
      // remove. So: an inline hint wins; else the classified arm's own
      // copy (consumer override first); else, for a kind this module has
      // no copy for, the neutral `unknown` text rather than one that
      // asserts a cause; else the unclassified `no_credential` default.
      hint:
        classified?.hint ??
        (isArm(classified?.kind)
          ? (hints?.[classified.kind] ??
            credentialHint(classified.kind, prefix, hostLabel, null))
          : classified !== undefined
            ? credentialHint('unknown', prefix, hostLabel, null)
            : (hints?.no_credential ??
              credentialHint('no_credential', prefix, hostLabel, null))),
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
}

/**
 * Register `${prefix}_healthcheck` for a connector whose health is about a
 * CREDENTIAL rather than a browser bridge. The body is
 * {@link runCredentialHealthcheck}.
 */
export function registerCredentialHealthcheckTool(
  args: RegisterCredentialHealthcheckToolArgs,
): void {
  args.server.registerTool(
    `${args.prefix}_healthcheck`,
    {
      title: 'Verify credentials and upstream reachability',
      description: `${credentialHealthcheckDescription(args.hostLabel)} Call this when a real tool fails and you want to know which hop broke.`,
      annotations: {
        title: 'Verify credentials and upstream reachability',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => runCredentialHealthcheck(args),
  );
}


/**
 * The probe reached the far side and it declined to serve the data — a login
 * page, or a redirect to one. Its own class so a classifier can tell it apart
 * from a network failure.
 */
export class SessionNotLiveError extends Error {
  constructor(
    readonly hostLabel: string,
    readonly detail: string,
  ) {
    super(`${hostLabel} served a sign-in page rather than the data (${detail}).`);
    this.name = 'SessionNotLiveError';
  }
}

/** A non-2xx from the far side, carrying the status the healthcheck reports. */
export class ProbeHttpError extends Error {
  constructor(
    readonly hostLabel: string,
    readonly status: number,
  ) {
    super(`${hostLabel} answered ${status}.`);
    this.name = 'ProbeHttpError';
  }
}

/** The minimum a {@link sessionProbe} request has to report. */
export interface ProbeResponse {
  status: number;
  body: string;
}

export interface SessionProbeOptions {
  /** Make the authenticated request. Must NOT sign in — a diagnostic observes. */
  request: () => Promise<ProbeResponse>;
  /**
   * **The site-specific closure**, and the only part of this that cannot be
   * generalised: does this body mean "not signed in"?
   *
   * It stays with the consumer because getting it wrong is silent and specific.
   * One real portal links to two-factor setup from every signed-in page, so a
   * body-wide match on `twoFactor` reports "signed out" for every request; the
   * fix was to scope it to the `<title>`, which is knowable only next to the
   * markup. A library that guessed this would be wrong in both directions.
   */
  signedOut: (body: string) => boolean;
  /** Used in the thrown messages. Defaults to a neutral phrase. */
  hostLabel?: string;
}

/**
 * Build a `probeFn` that JUDGES its response instead of merely completing.
 *
 * `probeFn`'s contract is that it reports failure by throwing, so any probe
 * that can resolve on a signed-out response silently reports healthy. Every
 * connector whose probe rides a client that throws on non-2xx complies by
 * accident — and that accident does not hold against a SOFT wall, where a dead
 * session comes back 200 with a login page.
 *
 * The rules here are the generic ones:
 *
 *  - a 3xx is signed out, because under a manual-redirect fetch the bounce to
 *    the login page arrives with no body to judge;
 *  - any other non-2xx is an upstream error carrying its status;
 *  - a 2xx is signed out if the consumer's closure says so.
 *
 * Pair with {@link sessionClassifier} to turn those into arms and remedies.
 */
export function sessionProbe(opts: SessionProbeOptions): () => Promise<string> {
  const host = opts.hostLabel ?? 'the upstream';
  return async () => {
    const { status, body } = await opts.request();
    if (status >= 300 && status < 400) {
      throw new SessionNotLiveError(host, `redirected with ${status}`);
    }
    if (status < 200 || status >= 300) throw new ProbeHttpError(host, status);
    if (opts.signedOut(body)) throw new SessionNotLiveError(host, 'sign-in or verification page');
    return body;
  };
}

/**
 * The tools that fix each signed-out state, named EXPLICITLY.
 *
 * Never derived from the tool-name prefix. That was the first design and it was
 * wrong in a way that defeats the whole point of a healthcheck: it produced
 * `<prefix>_sign_in`, which exists in exactly one connector. simplepractice
 * calls it `simplepractice_request_sign_in_link`, kiaaccess `kia_start_login`
 * and `kia_verify_otp` — so the copy sent people to a tool that does not exist,
 * which is worse than saying nothing.
 *
 * Every field is optional. Omit one and the copy stays true but generic
 * ("sign in again") rather than naming something that may not be there.
 */
export interface SessionRemedyTools {
  /** Signs in from scratch, e.g. `'mah_sign_in'`. */
  signIn?: string;
  /** Asks the far side to send a code, e.g. `'mah_send_verification_code'`. */
  sendCode?: string;
  /** Submits the code the user received, e.g. `'mah_verify_code'`. */
  verifyCode?: string;
}

export interface SessionClassifierOptions {
  /** Display host named in the default copy, e.g. `'my.atriumhealth.org'`. */
  hostLabel: string;
  /** What to tell the caller to call. See {@link SessionRemedyTools}. */
  remedies?: SessionRemedyTools;
  /** A second factor is outstanding. Read at classification time, not captured. */
  verificationPending?: () => boolean;
  /** The far side refused this username and password. */
  credentialsRejected?: () => boolean;
  /** Per-kind copy overrides, for a connector whose remedy is not a tool call. */
  hints?: Partial<Record<'session_expired' | 'verification_pending' | 'credential_rejected' | 'http', string>>;
}

/**
 * Build a `classifyThrown` that names WHICH signed-out state a
 * {@link sessionProbe} failure is.
 *
 * All three arrive as the same login page and have three different remedies,
 * so reporting them as one sends people to the wrong fix — telling somebody
 * with an outstanding code to check their password sends them to change a
 * credential that is already correct.
 *
 * **A refused credential outranks a pending verification.** Both flags can be
 * set at once, and retrying a code against a password the far side refuses is
 * futile. Two call sites in one repo disagreed about this order, which is the
 * argument for the order living in exactly one place.
 *
 * Returns `undefined` for anything it does not recognise, so the built-in
 * ladder still classifies a network failure rather than being shadowed.
 */
export function sessionClassifier(
  opts: SessionClassifierOptions,
): (err: unknown) => { kind: string; hint?: string } | undefined {
  const { hostLabel, hints } = opts;
  const remedies = opts.remedies ?? {};
  /** `Call <tool>.` when the connector named one, else a plain instruction. */
  const call = (tool: string | undefined, fallback: string): string =>
    tool !== undefined ? `Call ${tool}.` : fallback;
  return (err: unknown) => {
    if (err instanceof ProbeHttpError) {
      return {
        kind: 'http',
        hint:
          hints?.http ??
          `${hostLabel} answered ${err.status}. The credential was never judged — that is an ` +
            'upstream problem, so retry, and if it persists the far side is down.',
      };
    }
    if (!(err instanceof SessionNotLiveError)) return undefined;
    if (opts.credentialsRejected?.() === true) {
      return {
        kind: 'credential_rejected',
        hint:
          hints?.credential_rejected ??
          `${hostLabel} refused this username and password. Correct them, then sign in ` +
            `again. ${call(remedies.signIn, '')}`.trim() +
            ' Nothing retries for you: repeated failures escalate to a captcha or a lockout.',
      };
    }
    if (opts.verificationPending?.() === true) {
      return {
        kind: 'verification_pending',
        hint:
          hints?.verification_pending ??
          `A verification code is outstanding, so ${hostLabel} is holding the sign-in rather ` +
            'than refusing it. ' +
            (remedies.sendCode !== undefined && remedies.verifyCode !== undefined
              ? `Call ${remedies.sendCode}, then pass the code the ACCOUNT HOLDER receives to ` +
                `${remedies.verifyCode}.`
              : 'Supply the verification code the ACCOUNT HOLDER received; the credential ' +
                'itself is not the problem, so changing it will not help.'),
      };
    }
    return {
      kind: 'session_expired',
      hint:
        hints?.session_expired ??
        `The credentials are configured but no session is live — ${hostLabel} sessions are ` +
          'short-lived, so this recurs between uses. ' +
          call(remedies.signIn, 'Sign in again.') +
          ' Expect a verification code, which goes to the account holder.',
    };
  };
}
