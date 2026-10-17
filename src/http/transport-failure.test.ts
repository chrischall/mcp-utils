/**
 * fleet-audit#1306: microsoft-teams-mcp `src/network-error.ts` turns undici's
 * bare `TypeError('fetch failed')` into an error naming the host, the cause
 * code and a hint keyed to it; office-outlook-mcp (same archetype) has
 * nothing like it. These are teams' own cases, against the shared copy.
 */
import { describe, expect, it } from 'vitest';
import { McpToolError } from '../errors/index.js';
import { describeTransportFailure, isFetchFailedError, transportCauseCode } from './index.js';

function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

function sysError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const IMG = 'https://in-api.asm.skype.com/v1/objects/0-sin-d3-abc/views/imgo?secret=1';

describe('transportCauseCode', () => {
  it('reads the code off the cause', () => {
    expect(transportCauseCode(fetchFailed(sysError('ENOTFOUND', 'getaddrinfo ENOTFOUND x')))).toBe('ENOTFOUND');
  });

  it('reads the first code inside an AggregateError (both address families refused)', () => {
    const agg = new AggregateError([sysError('ECONNREFUSED', 'a'), sysError('ECONNREFUSED', 'b')], '');
    expect(transportCauseCode(fetchFailed(agg))).toBe('ECONNREFUSED');
  });

  it('follows a nested cause chain', () => {
    const inner = sysError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate');
    expect(transportCauseCode(fetchFailed(new Error('wrapped', { cause: inner })))).toBe('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
  });

  it('is undefined when no code is anywhere in the chain', () => {
    expect(transportCauseCode(fetchFailed(new Error('other side closed')))).toBeUndefined();
  });

  it('stops on a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(transportCauseCode(fetchFailed(a))).toBeUndefined();
  });
});

describe('isFetchFailedError', () => {
  it('is fetch\'s "never got a response" TypeError, and nothing else', () => {
    expect(isFetchFailedError(fetchFailed(undefined))).toBe(true);
    expect(isFetchFailedError(new TypeError('Invalid URL'))).toBe(false);
    expect(isFetchFailedError(new Error('fetch failed'))).toBe(false);
  });
});

describe('describeTransportFailure', () => {
  it('names the host and the code, never the path or query', () => {
    const err = describeTransportFailure(
      fetchFailed(sysError('ENOTFOUND', 'getaddrinfo ENOTFOUND in-api.asm.skype.com')),
      IMG,
      'Teams image store',
    );
    expect(err).toBeInstanceOf(McpToolError);
    expect(err!.message).toBe('Could not reach Teams image store at in-api.asm.skype.com (ENOTFOUND: getaddrinfo ENOTFOUND in-api.asm.skype.com).');
    expect(err!.message).not.toContain('/v1/objects');
    expect(err!.message).not.toContain('secret');
    expect(err!.kind).toBe('transport');
    expect(err!.hint).toMatch(/DNS|VPN/);
    expect(err!.hint).toContain('nslookup in-api.asm.skype.com');
  });

  it.each([
    ['ECONNREFUSED', /proxy|firewall/i],
    ['ECONNRESET', /proxy|firewall/i],
    ['ETIMEDOUT', /proxy|firewall/i],
    ['UND_ERR_CONNECT_TIMEOUT', /proxy|firewall/i],
    ['ENETUNREACH', /proxy|firewall/i],
    ['EAI_AGAIN', /DNS|VPN/],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', /NODE_EXTRA_CA_CERTS/],
    ['SELF_SIGNED_CERT_IN_CHAIN', /NODE_EXTRA_CA_CERTS/],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /NODE_EXTRA_CA_CERTS/],
    ['CERT_HAS_EXPIRED', /NODE_EXTRA_CA_CERTS|clock/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', /NODE_EXTRA_CA_CERTS|intercept/i],
  ])('gives an actionable hint for %s', (code, hint) => {
    const err = describeTransportFailure(fetchFailed(sysError(code, `x ${code}`)), IMG, 'Teams image store');
    expect(err!.message).toContain(code);
    expect(err!.hint).toMatch(hint);
  });

  it('points a refused connection at the proxy settings Node actually reads, naming the service', () => {
    const err = describeTransportFailure(fetchFailed(sysError('ECONNREFUSED', 'connect ECONNREFUSED')), IMG, 'Outlook');
    expect(err!.hint).toContain('NODE_USE_ENV_PROXY=1');
    expect(err!.hint).toContain('HTTPS_PROXY');
    expect(err!.hint).toContain('before Outlook answered');
  });

  it('still reports host and cause message when the code is unknown, with a curl check', () => {
    const err = describeTransportFailure(fetchFailed(new Error('other side closed')), IMG, 'Teams image store');
    expect(err!.message).toBe('Could not reach Teams image store at in-api.asm.skype.com (other side closed).');
    expect(err!.hint).toContain('curl -sI https://in-api.asm.skype.com/');
  });

  it('says only the host when there is no detail at all', () => {
    expect(describeTransportFailure(fetchFailed(undefined), IMG, 'X')!.message).toBe('Could not reach X at in-api.asm.skype.com.');
  });

  it('copes with a URL it cannot parse', () => {
    expect(describeTransportFailure(fetchFailed(undefined), 'not a url', 'X')!.message).toContain('(unknown host)');
  });

  it('chains the original error as cause', () => {
    const original = fetchFailed(sysError('ECONNRESET', 'reset'));
    expect(describeTransportFailure(original, IMG, 'X')!.cause).toBe(original);
  });

  it('leaves anything that is not a transport failure to the caller', () => {
    expect(describeTransportFailure(new McpToolError('HTTP 404'), IMG, 'x')).toBeUndefined();
    expect(describeTransportFailure(new Error('boom'), IMG, 'x')).toBeUndefined();
    expect(describeTransportFailure(new TypeError('Invalid URL'), IMG, 'x')).toBeUndefined();
  });

  it('lets a server word its own hint per failure class (teams names its regional hosts)', () => {
    const err = describeTransportFailure(fetchFailed(sysError('ENOTFOUND', 'x')), IMG, 'Teams', {
      hints: { dns: (host) => `split-tunnel VPN: try nslookup ${host}` },
    });
    expect(err!.hint).toBe('split-tunnel VPN: try nslookup in-api.asm.skype.com');
    const other = describeTransportFailure(fetchFailed(sysError('ECONNRESET', 'x')), IMG, 'Teams', {
      hints: { dns: () => 'unused' },
    });
    expect(other!.hint).toContain('HTTPS_PROXY');
  });
});

describe('describeTransportFailure — an egress proxy that refused the tunnel', () => {
  function proxyRefused(status: number): TypeError {
    const aborted = Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), {
      name: 'RequestAbortedError',
      code: 'UND_ERR_ABORTED',
    });
    return fetchFailed(Object.assign(new Error('Request was cancelled.', { cause: aborted }), { code: 0 }));
  }

  const FILE = 'https://contoso.sharepoint.com/_api/v2.1/shares/u!abc/driveItem';

  it('says the network policy refused the host, not "check DNS/VPN"', () => {
    const err = describeTransportFailure(proxyRefused(403), FILE, 'SharePoint');
    expect(err!.message).toContain('contoso.sharepoint.com');
    expect(err!.message).not.toContain('/_api');
    expect(err!.hint).toMatch(/egress/i);
    expect(err!.hint).toMatch(/allow/i);
    expect(err!.hint).not.toMatch(/VPN|DNS|nslookup|curl/);
  });

  it("treats Node http's ERR_PROXY_TUNNEL the same way", () => {
    const err = describeTransportFailure(
      fetchFailed(Object.assign(new Error('Failed to establish tunnel: proxy returned 403'), { code: 'ERR_PROXY_TUNNEL' })),
      FILE,
      'SharePoint',
    );
    expect(err!.hint).toMatch(/egress/i);
    expect(err!.hint).not.toMatch(/VPN|DNS/);
  });

  it('a proxy that answered 502 (could not reach the host) is not called a policy refusal', () => {
    const err = describeTransportFailure(proxyRefused(502), FILE, 'SharePoint');
    expect(err!.hint).not.toMatch(/egress allow/i);
    expect(err!.hint).toMatch(/proxy/i);
    expect(err!.hint).toContain('it answered 502');
  });
});
