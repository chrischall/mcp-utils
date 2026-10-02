import { describe, expect, it } from 'vitest';

import {
  registerCredentialHealthcheckTool,
  SessionNotLiveError,
  sessionClassifier,
  sessionProbe,
} from './index.js';
import { createTestHarness, parseToolResult } from '../test/index.js';

interface Result {
  ok: boolean;
  credential: { source: string | null; resolved: boolean; detail?: Record<string, unknown> };
  probe: { url?: string; elapsed_ms: number; status?: number };
  error?: { kind: string; message: string; detail?: Record<string, unknown> };
  hint: string;
}

async function run(args: Parameters<typeof registerCredentialHealthcheckTool>[0]) {
  const h = await createTestHarness((server) =>
    registerCredentialHealthcheckTool({ ...args, server }),
  );
  const res = await h.client.callTool({ name: 'demo_healthcheck', arguments: {} });
  await h.close?.();
  return parseToolResult<Result>(res as never);
}

const base = {
  prefix: 'demo',
  hostLabel: 'api.demo.com',
  probePath: '/v1/me',
} as const;

describe('registerCredentialHealthcheckTool', () => {
  it('reports ok when the credential resolves and the probe succeeds', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env', detail: { age_days: 3 } }),
      probeFn: async () => ({ id: 1 }),
    });
    expect(r.ok).toBe(true);
    expect(r.credential).toMatchObject({ source: 'env', resolved: true, detail: { age_days: 3 } });
    expect(r.probe.url).toBe('https://api.demo.com/v1/me');
    expect(r.error).toBeUndefined();
  });

  it('renders a slashless probePath as a URL rather than gluing it to the host', async () => {
    // The bridge arm has the same fix and its own test. This one guards the
    // credential arm, where an MCP whose app root sits under the host passes a
    // bare path and used to get `https://api.demo.comv1/me` back — a URL that
    // reads as broken in the one output people paste into a bug report.
    const r = await run({
      ...base,
      probePath: 'v1/me',
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => ({ id: 1 }),
    });
    expect(r.probe.url).toBe('https://api.demo.com/v1/me');
  });

  it('does not double the separator on a probePath that already has one', async () => {
    const r = await run({
      ...base,
      probePath: '/v1/me',
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => ({ id: 1 }),
    });
    expect(r.probe.url).toBe('https://api.demo.com/v1/me');
  });

  // The whole reason this helper exists: "no credential" and "credential
  // rejected" are different problems with different fixes, and today they both
  // surface as one opaque error.
  it('distinguishes no_credential from a rejected one', async () => {
    const none = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: null }),
      probeFn: async () => {
        throw new Error('should not be probed');
      },
    });
    expect(none.ok).toBe(false);
    expect(none.error?.kind).toBe('no_credential');
    expect(none.credential.resolved).toBe(false);
    expect(none.hint).toMatch(/sign in|credential|token/i);
  });

  it('does not probe at all when no credential resolved', async () => {
    let probed = false;
    await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: null }),
      probeFn: async () => {
        probed = true;
        return {};
      },
    });
    expect(probed).toBe(false);
  });

  it('classifies a 401 as credential_rejected, not a generic http error', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'fetchproxy' }),
      probeFn: async () => {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
    });
    expect(r.error?.kind).toBe('credential_rejected');
    expect(r.credential.source).toBe('fetchproxy');
  });

  it('keeps a non-auth http status as http', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw Object.assign(new Error('Server error'), { status: 503 });
      },
    });
    expect(r.error?.kind).toBe('http');
  });

  it('lets a consumer re-kind a thrown error and supply copy', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new Error('district not selected');
      },
      classifyThrown: (e) =>
        (e as Error).message.includes('district')
          ? { kind: 'needs_district', hint: 'Pick a district first.', detail: { field: 'IC_DISTRICT' } }
          : undefined,
    });
    expect(r.error?.kind).toBe('needs_district');
    expect(r.error?.detail).toEqual({ field: 'IC_DISTRICT' });
    expect(r.hint).toBe('Pick a district first.');
  });

  it('reports a resolver that itself throws rather than crashing the tool', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => {
        throw new Error('bridge minted nothing');
      },
      probeFn: async () => ({}),
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('no_credential');
    expect(r.error?.message).toMatch(/bridge minted nothing/);
  });

  it('measures elapsed time even on failure', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new Error('nope');
      },
    });
    expect(typeof r.probe.elapsed_ms).toBe('number');
  });

  it('omits the probe URL when no probePath was configured', async () => {
    const r = await run({
      prefix: 'demo',
      hostLabel: 'api.demo.com',
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => ({}),
    });
    expect(r.probe.url).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("classifies a bare AbortController abort as timeout, by err.name", async () => {
    // The message carries nothing useful for a bare abort — matching text
    // alone classified these as 'unknown'. src/http/index.ts checks err.name.
    const abort = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw abort;
      },
    });
    expect(r.error?.kind).toBe('timeout');
  });

  it("classifies a message-shaped timeout as timeout", async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new Error('ETIMEDOUT connecting to host');
      },
    });
    expect(r.error?.kind).toBe('timeout');
  });

  it('classifies an unreachable host as transport', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new Error('fetch failed');
      },
    });
    expect(r.error?.kind).toBe('transport');
    expect(r.hint).toMatch(/reach/i);
  });

  it('honours a per-arm hints override', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: null }),
      probeFn: async () => ({}),
      hints: { no_credential: 'Connect the connector first.' },
    });
    expect(r.hint).toBe('Connect the connector first.');
  });

  // A healthcheck is the tool people paste into a chat when something is
  // broken, and upstream failures routinely quote what they were sent.
  it('redacts secrets out of an upstream error message', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new Error('rejected: Bearer sk-live-ABCDEF1234567890abcdef');
      },
    });
    expect(r.error?.message ?? '').not.toContain('sk-live-ABCDEF1234567890abcdef');
  });

  it('redacts a secret thrown by the resolver too', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => {
        throw new Error('mint failed for Bearer sk-live-ABCDEF1234567890abcdef');
      },
      probeFn: async () => ({}),
    });
    expect(r.error?.message ?? '').not.toContain('sk-live-ABCDEF1234567890abcdef');
  });

  // Resolving can mint a token or drive the browser bridge; counting that as
  // probe latency reports it as far-side slowness.
  it('excludes credential-resolution time from probe.elapsed_ms', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => {
        await new Promise((res) => setTimeout(res, 60));
        return { source: 'env' };
      },
      probeFn: async () => ({}),
    });
    expect(r.probe.elapsed_ms).toBeLessThan(50);
  });

  it('emits no probe.url on the no-credential paths', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: null }),
      probeFn: async () => ({}),
    });
    expect(r.probe.url).toBeUndefined();
  });
});

// A `resolveCredential` that THROWS used to be flattened into `no_credential`
// with that arm's static hint, whatever the cause. So "nothing is configured"
// and "the browser bridge is down" — or a password the upstream rejected —
// came out identical, and the one hint on offer told people to set variables
// that were already set. Consumers could classify a PROBE failure and not this.
describe('a resolver throw can be classified', () => {
  const base = {
    prefix: 'demo',
    hostLabel: 'example.com',
    probeFn: async () => ({ ok: true }),
  };

  it('uses classifyThrown for a resolver failure that is not a missing credential', async () => {
    const r = await run({
      ...base,
      resolveCredential: async () => {
        throw new Error('bridge is down');
      },
      classifyThrown: (err) =>
        String((err as Error).message).includes('bridge')
          ? { kind: 'transport', hint: 'The bridge is down — start the extension.', detail: { hop: 'bridge' } }
          : undefined,
    } as never);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('transport');
    expect(r.error?.detail).toEqual({ hop: 'bridge' });
    expect(r.hint).toBe('The bridge is down — start the extension.');
    // Still true: nothing resolved. The classification explains WHY, it does
    // not invent a credential.
    expect(r.credential.resolved).toBe(false);
    expect(r.credential.source).toBeNull();
    // Nothing was probed, so no url may be implied.
    expect(r.probe.url).toBeUndefined();
  });

  it('falls back to no_credential when classifyThrown declines', async () => {
    const r = await run({
      ...base,
      resolveCredential: async () => {
        throw new Error('nothing configured');
      },
      classifyThrown: () => undefined,
    } as never);
    expect(r.error?.kind).toBe('no_credential');
    expect(r.error?.message).toMatch(/nothing configured/);
  });

  // Backwards compatibility: every consumer written before this passes no
  // classifier at all, and must behave exactly as it did.
  it('is unchanged when no classifier is supplied', async () => {
    const r = await run({
      ...base,
      resolveCredential: async () => {
        throw new Error('boom');
      },
    } as never);
    expect(r.error?.kind).toBe('no_credential');
    expect(r.hint).toMatch(/No credential resolved/i);
  });

  it('still prefers an explicit hints override for the fallback arm', async () => {
    const r = await run({
      ...base,
      resolveCredential: async () => {
        throw new Error('boom');
      },
      hints: { no_credential: 'custom copy' },
    } as never);
    expect(r.hint).toBe('custom copy');
  });
});

// A classifier may name a kind without supplying copy. The hint then has to
// follow THAT kind — falling back to `no_credential`'s copy would state a
// cause the `kind` beside it contradicts, which is the whole failure this
// classification path exists to remove.
describe('a classified resolver throw gets a hint matching its kind', () => {
  const base = {
    prefix: 'demo',
    hostLabel: 'example.com',
    probeFn: async () => ({ ok: true }),
    resolveCredential: async () => {
      throw new Error('bridge is down');
    },
  };

  it('uses the classified arm’s default copy when the classifier gives no hint', async () => {
    const r = await run({ ...base, classifyThrown: () => ({ kind: 'transport' }) } as never);
    expect(r.error?.kind).toBe('transport');
    expect(r.hint).not.toMatch(/No credential resolved/i);
    // transport's own copy, not no_credential's
    expect(r.hint).toMatch(/example\.com/);
  });

  it('prefers a hints override for the CLASSIFIED arm, not for no_credential', async () => {
    const r = await run({
      ...base,
      classifyThrown: () => ({ kind: 'transport' }),
      hints: { transport: 'transport copy', no_credential: 'WRONG' },
    } as never);
    expect(r.hint).toBe('transport copy');
  });

  // A consumer may use a kind of its own (kia_healthcheck reports
  // `no_session`). There is no copy for it, and no_credential's would assert a
  // cause that kind denies — so the neutral `unknown` copy is the honest one.
  it('does not assert a cause for a custom kind it has no copy for', async () => {
    const r = await run({ ...base, classifyThrown: () => ({ kind: 'no_session' }) } as never);
    expect(r.error?.kind).toBe('no_session');
    expect(r.hint).not.toMatch(/No credential resolved/i);
  });

  it('an inline hint still wins over everything', async () => {
    const r = await run({
      ...base,
      classifyThrown: () => ({ kind: 'transport', hint: 'inline' }),
      hints: { transport: 'override' },
    } as never);
    expect(r.hint).toBe('inline');
  });
});

describe('sessionProbe / sessionClassifier', () => {
  const LOGIN = '<title>Login Page</title>';
  const HOME = '<title>Home</title>';
  /** The one site-specific thing: what a signed-out body looks like here. */
  const signedOut = (body: string) => body.includes('Login Page');

  async function runSession(
    responses: { status: number; body: string },
    flags: { verificationPending?: boolean; credentialsRejected?: boolean } = {},
  ) {
    return run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: sessionProbe({ request: async () => responses, signedOut }),
      classifyThrown: sessionClassifier({
        hostLabel: 'api.demo.com',
        remedies: {
          signIn: 'demo_sign_in',
          sendCode: 'demo_send_verification_code',
          verifyCode: 'demo_verify_code',
        },
        verificationPending: () => flags.verificationPending === true,
        credentialsRejected: () => flags.credentialsRejected === true,
      }),
    });
  }

  it('accepts a 2xx body the closure does not call signed out', async () => {
    const r = await runSession({ status: 200, body: HOME });
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('rejects a 2xx body the closure calls signed out', async () => {
    // The whole point: a resolved 200 is not proof of a session.
    const r = await runSession({ status: 200, body: LOGIN });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('session_expired');
    expect(r.hint).toContain('demo_sign_in');
  });

  it('treats a redirect as signed out, with no body to judge', async () => {
    const r = await runSession({ status: 302, body: '' });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('session_expired');
  });

  it('reports a non-2xx as http, carrying its status', async () => {
    const r = await runSession({ status: 503, body: '' });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('http');
    expect(r.probe.status).toBe(503);
  });

  it('names a pending verification rather than a dead session', async () => {
    const r = await runSession({ status: 200, body: LOGIN }, { verificationPending: true });
    expect(r.error?.kind).toBe('verification_pending');
    expect(r.hint).toContain('code');
  });

  it('lets a rejected credential win over a pending verification', async () => {
    // Both flags set. Retrying a code against a password the far side refuses
    // is futile, so the credential is the one to report — and two call sites
    // disagreeing about this order is exactly what putting it here removes.
    const r = await runSession(
      { status: 200, body: LOGIN },
      { verificationPending: true, credentialsRejected: true },
    );
    expect(r.error?.kind).toBe('credential_rejected');
  });

  it("passes a non-probe throw through to the caller's own classifier", async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new Error('kaboom');
      },
      classifyThrown: sessionClassifier({ hostLabel: 'api.demo.com' }),
    });
    // sessionClassifier declines what it does not recognise, so the built-in
    // ladder still classifies it rather than being shadowed.
    expect(r.error?.kind).toBe('unknown');
  });
});

describe('sessionClassifier remedy naming', () => {
  const LOGIN = '<title>Login Page</title>';
  const probe = sessionProbe({
    request: async () => ({ status: 200, body: LOGIN }),
    signedOut: (b) => b.includes('Login Page'),
  });

  async function withRemedies(remedies?: Parameters<typeof sessionClassifier>[0]['remedies']) {
    return run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: probe,
      classifyThrown: sessionClassifier({
        hostLabel: 'api.demo.com',
        ...(remedies ? { remedies } : {}),
      }),
    });
  }

  it('names no tool at all when the connector named none', async () => {
    // The trap this replaces: copy derived from the tool-name prefix produced
    // `<prefix>_sign_in`, which exists in exactly ONE connector. simplepractice
    // calls it simplepractice_request_sign_in_link and kiaaccess kia_start_login,
    // so the healthcheck sent people to a tool that is not there — worse than
    // generic advice, because the tool's whole job is to point at the fix.
    const r = await withRemedies();
    expect(r.error?.kind).toBe('session_expired');
    expect(r.hint).toContain('Sign in again');
    expect(r.hint).not.toMatch(/\b\w+_sign_in\b/);
  });

  it('uses the connector-s own tool names verbatim', async () => {
    const r = await withRemedies({ signIn: 'simplepractice_request_sign_in_link' });
    expect(r.hint).toContain('Call simplepractice_request_sign_in_link.');
  });

  it('keeps the verification copy generic unless BOTH code tools are named', async () => {
    // Half a flow is not a flow: naming only the sender leaves the caller with
    // a code and nowhere to put it.
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: probe,
      classifyThrown: sessionClassifier({
        hostLabel: 'api.demo.com',
        remedies: { sendCode: 'kia_send_otp' },
        verificationPending: () => true,
      }),
    });
    expect(r.error?.kind).toBe('verification_pending');
    expect(r.hint).not.toContain('kia_send_otp');
    expect(r.hint).toContain('ACCOUNT HOLDER');
  });

  it('classifies a SessionNotLiveError thrown by a client-method probe', async () => {
    // The other adoption path: a connector whose probe rides a client that
    // already throws on non-2xx keeps its own probeFn and throws the exported
    // class for the soft wall its client cannot see.
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new SessionNotLiveError('api.demo.com', 'sign-in page');
      },
      classifyThrown: sessionClassifier({
        hostLabel: 'api.demo.com',
        remedies: { signIn: 'demo_sign_in' },
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('session_expired');
    expect(r.hint).toContain('Call demo_sign_in.');
  });
});

describe('a classified kind selects the hint, on the probe path too', () => {
  // The resolveCredential path already honoured a classified kind when picking
  // copy. The probe path did not: `arm` was computed from the HTTP status and
  // never moved, so a classifier that named an arm without supplying a hint got
  // `error.kind: 'credential_rejected'` printed next to
  // `hint: 'Unexpected failure — see error.message.'` — a payload that
  // contradicts itself, in the tool people paste into a chat when something is
  // broken. Found in resy-mcp, whose client throws an auth error carrying no
  // status at all (it rewrites 419 and auth-shaped 500s into a synthetic 401
  // for its replay, then throws without one), so its hand-written
  // credential_rejected copy was unreachable.
  class AuthRefused extends Error {}

  it("uses the consumer's own copy for the classified arm", async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new AuthRefused('refused');
      },
      classifyThrown: (e) => (e instanceof AuthRefused ? { kind: 'credential_rejected' } : undefined),
      hints: { credential_rejected: 'Check the three mint paths.' },
    });
    expect(r.error?.kind).toBe('credential_rejected');
    expect(r.hint).toBe('Check the three mint paths.');
  });

  it("falls back to the classified arm's default copy, not the status-derived one", async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new AuthRefused('refused');
      },
      classifyThrown: (e) => (e instanceof AuthRefused ? { kind: 'credential_rejected' } : undefined),
    });
    expect(r.hint).not.toMatch(/Unexpected failure/);
    expect(r.hint).toMatch(/rejected the credential/);
  });

  it('still prefers an explicit hint from the classifier', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new AuthRefused('refused');
      },
      classifyThrown: () => ({ kind: 'credential_rejected', hint: 'Inline wins.' }),
      hints: { credential_rejected: 'Should not be used.' },
    });
    expect(r.hint).toBe('Inline wins.');
  });

  it('keeps neutral copy for a kind this module has none for', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw Object.assign(new Error('teapot'), { status: 418 });
      },
      // A kind outside the arm set, and no hint: the status-derived `http` copy
      // would now contradict it, so neither is asserted.
      classifyThrown: () => ({ kind: 'brewing' }),
    });
    expect(r.error?.kind).toBe('brewing');
    expect(r.hint).toMatch(/Unexpected failure/);
  });
});

describe('a CDN/WAF block is edge_blocked, not credential_rejected (mcp-host#1015)', () => {
  // What zola-mcp's own client throws for the CloudFront page: status 403, and
  // a message that is `formatApiError`'s 500-character cut of the HTML — so the
  // `Generated by cloudfront` line at the bottom of the page is already gone.
  const cloudFrontPage =
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">' +
    '<HTML><HEAD><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=iso-8859-1">' +
    '<TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY><H1>403 ERROR</H1>' +
    '<H2>The request could not be satisfied.</H2><HR noshade size="1px">Request blocked.';
  function zolaStyleError(): Error {
    const err = new Error(`Zola API error 403 for GET /v4/your-wedding: ${cloudFrontPage}`) as Error & {
      status: number;
      bodyPreview: string;
    };
    err.status = 403;
    err.bodyPreview = cloudFrontPage;
    return err;
  }

  it('reports a 403 CloudFront block page as edge_blocked with an edge hint', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw zolaStyleError();
      },
      // The consumer's credential_rejected copy must not be what this reads.
      hints: { credential_rejected: 'Zola rejected the refresh token. Re-sign in.' },
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('edge_blocked');
    expect(r.error?.detail).toEqual({ vendor: 'CloudFront' });
    expect(r.probe.status).toBe(403);
    expect(r.hint).toMatch(/CDN/);
    expect(r.hint).toMatch(/never judged|not evaluated/);
    expect(r.hint).not.toMatch(/Re-sign in/);
  });

  it('reads the block from an EdgeBlockedError thrown by createApiClient', async () => {
    const { EdgeBlockedError } = await import('../http/index.js');
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw new EdgeBlockedError(403, 'Cloudflare', { service: 'Demo', method: 'GET', path: '/v1/me' });
      },
    });
    expect(r.error?.kind).toBe('edge_blocked');
    expect(r.error?.detail).toEqual({ vendor: 'Cloudflare' });
  });

  it('reads the block off an error whose `response` carries the page (FetchproxyHttpError, most HTTP libs)', async () => {
    const err = Object.assign(new Error('HTTP 403 on https://x.test/v1/me'), {
      response: { status: 403, body: cloudFrontPage, url: 'https://x.test/v1/me' },
    });
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw err;
      },
    });
    expect(r.error?.kind).toBe('edge_blocked');
    expect(r.error?.detail).toEqual({ vendor: 'CloudFront' });
  });

  it('keeps an error whose `response` is an ordinary 403 credential_rejected', async () => {
    const err = Object.assign(new Error('HTTP 403'), {
      status: 403,
      response: { status: 403, body: '{"error":"forbidden"}', headers: { 'x-cache': 'Error from cloudfront' } },
    });
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw err;
      },
    });
    expect(r.error?.kind).toBe('credential_rejected');
  });

  it('is edge_blocked on a non-auth status too (a 503 challenge is not an "http" fault)', async () => {
    const err = Object.assign(
      new Error('API error 503 for GET /v1/me: <html><title>Just a moment...</title><script>_cf_chl_opt={}</script>'),
      { status: 503 },
    );
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw err;
      },
    });
    expect(r.error?.kind).toBe('edge_blocked');
  });

  it('keeps a CloudFront 502 page http: an outage is not a block', async () => {
    const err = Object.assign(
      new Error(`API error 502 for GET /v1/me: ${cloudFrontPage.replace('403 ERROR', '502 ERROR')}`),
      { status: 502 },
    );
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw err;
      },
    });
    expect(r.error?.kind).toBe('http');
  });

  it("keeps the vendor when the consumer's classifier gives no detail of its own", async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw zolaStyleError();
      },
      classifyThrown: () => ({ kind: 'custom_kind' }),
    });
    expect(r.error?.detail).toEqual({ vendor: 'CloudFront' });
  });

  it('reports a cookie-session probe that met a CDN block as edge_blocked', async () => {
    const page = `<HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY>Request blocked.</BODY></HTML>`;
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'cookie' }),
      probeFn: sessionProbe({ request: async () => ({ status: 403, body: page }), signedOut: () => false, hostLabel: 'api.demo.com' }),
      classifyThrown: sessionClassifier({ hostLabel: 'api.demo.com' }),
    });
    expect(r.error?.kind).toBe('edge_blocked');
    expect(r.error?.detail).toEqual({ vendor: 'CloudFront' });
  });

  it('keeps an origin 403 credential_rejected (control)', async () => {
    const err = Object.assign(new Error('API error 403 for GET /v1/me: {"error":"invalid_token"}'), { status: 403 });
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw err;
      },
    });
    expect(r.error?.kind).toBe('credential_rejected');
  });

  it("lets the consumer's classifier still decide", async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw zolaStyleError();
      },
      classifyThrown: () => ({ kind: 'custom_kind', hint: 'mine' }),
    });
    expect(r.error?.kind).toBe('custom_kind');
    expect(r.hint).toBe('mine');
  });

  it('honours a hints override for edge_blocked', async () => {
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => ({ source: 'env' }),
      probeFn: async () => {
        throw zolaStyleError();
      },
      hints: { edge_blocked: 'Route through the bridge.' },
    });
    expect(r.hint).toBe('Route through the bridge.');
  });

  it('classifies a resolver that hit the block as edge_blocked rather than no_credential', async () => {
    // A token refresh goes through the same CDN; a blocked refresh is not a
    // missing credential, and "set the variable" is the wrong advice.
    const r = await run({
      ...base,
      server: null as never,
      resolveCredential: async () => {
        throw zolaStyleError();
      },
      probeFn: async () => ({}),
    });
    expect(r.error?.kind).toBe('edge_blocked');
    expect(r.credential.resolved).toBe(false);
    expect(r.hint).toMatch(/CDN/);
  });
});
