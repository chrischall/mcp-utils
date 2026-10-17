/**
 * fleet-audit#1305: microsoft-teams-mcp (`auth-fetchproxy.ts`,
 * `sharepoint-auth.ts`, `substrate-auth.ts`) and office-outlook-mcp
 * (`auth-fetchproxy.ts`) each carry the same ~60-line capture of a bearer
 * header off the signed-in tab. These are the donors' own cases.
 */
import { describe, expect, it, vi } from 'vitest';
import { captureBearerHeader, createLazyTransport, raceCaptures, stripBearer, type CaptureBearerHeaderOptions } from './index.js';

const FAKE_TOKEN = 'x'.repeat(200);

const TEAMS = { host: 'teams.cloud.microsoft', path: '/api/chatsvc/*', headerName: 'authorization' };

function harness(capture: (decl: { host: string; timeoutMs?: number }) => Promise<unknown>) {
  const start = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const captureRequestHeader = vi.fn(capture);
  const createTransport = vi.fn((_opts: Record<string, unknown>) => ({ start, close, server: { captureRequestHeader } }));
  return { start, close, captureRequestHeader, createTransport };
}

function teamsOpts(h: ReturnType<typeof harness>, extra: Partial<CaptureBearerHeaderOptions> = {}): CaptureBearerHeaderOptions {
  return {
    captures: [TEAMS],
    windowMs: 30_000,
    port: 37_149,
    serverName: 'microsoft-teams-mcp',
    version: '1.2.3',
    what: 'a Teams token',
    guidance: 'Open a signed-in teams.cloud.microsoft tab and click into any chat, then retry.',
    createTransport: h.createTransport as never,
    ...extra,
  };
}

describe('stripBearer', () => {
  it('drops a Bearer prefix in any case and trims', () => {
    expect(stripBearer('Bearer abc')).toBe('abc');
    expect(stripBearer('bearer  abc ')).toBe('abc');
    expect(stripBearer('  abc  ')).toBe('abc');
  });
});

describe('captureBearerHeader — one declaration (teams)', () => {
  it('captures with the declared host/path/header and the window, and returns the bare token', async () => {
    const h = harness(async () => `Bearer ${FAKE_TOKEN}`);
    await expect(captureBearerHeader(teamsOpts(h))).resolves.toBe(FAKE_TOKEN);
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.captureRequestHeader).toHaveBeenCalledWith({ ...TEAMS, timeoutMs: 30_000 });
    const opts = h.createTransport.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.domains).toEqual(['teams.cloud.microsoft']);
    expect(opts.port).toBe(37_149);
    expect([...(opts.capabilities as string[])].sort()).toEqual(['capture_request_header', 'fetch']);
    expect(opts.captureHeaders).toEqual([TEAMS]);
    expect(opts.serverName).toBe('microsoft-teams-mcp');
    expect(opts.version).toBe('1.2.3');
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('derives the bridge deadline from the window, for every bridge version (window + 15 s, never under 30 s)', async () => {
    const h = harness(async () => FAKE_TOKEN);
    await captureBearerHeader(teamsOpts(h));
    expect(h.createTransport.mock.calls[0]![0]).toMatchObject({ fetchTimeoutMs: 45_000, captureWindowMs: 30_000 });
    const h2 = harness(async () => FAKE_TOKEN);
    await captureBearerHeader(teamsOpts(h2, { windowMs: 120_000 }));
    expect(h2.createTransport.mock.calls[0]![0]).toMatchObject({ fetchTimeoutMs: 135_000, captureWindowMs: 120_000 });
    expect(h2.captureRequestHeader).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 120_000 }));
    const h3 = harness(async () => FAKE_TOKEN);
    await captureBearerHeader(teamsOpts(h3, { windowMs: 5_000 }));
    expect(h3.createTransport.mock.calls[0]![0]).toMatchObject({ fetchTimeoutMs: 30_000 });
  });

  it('trusts a separate domain list when given (sharepoint.com for a tenant host)', async () => {
    const h = harness(async () => FAKE_TOKEN);
    await captureBearerHeader(teamsOpts(h, { captures: [{ host: 'contoso.sharepoint.com', path: '/*', headerName: 'authorization' }], domains: ['sharepoint.com'] }));
    expect((h.createTransport.mock.calls[0]![0] as { domains: string[] }).domains).toEqual(['sharepoint.com']);
  });

  it('rejects a header too short to be a token, with the guidance', async () => {
    const h = harness(async () => 'Bearer short');
    const err = (await captureBearerHeader(teamsOpts(h)).catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      'could not capture a Teams token from the browser (teams.cloud.microsoft: authorization header was present but too short to be a token (5 chars)). ' +
        'Open a signed-in teams.cloud.microsoft tab and click into any chat, then retry.',
    );
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('honours minLength (resy: 20)', async () => {
    const h = harness(async () => 'k'.repeat(25));
    await expect(captureBearerHeader(teamsOpts(h, { minLength: 20 }))).resolves.toBe('k'.repeat(25));
  });

  it('rejects a capture that returned no header', async () => {
    const h = harness(async () => undefined);
    await expect(captureBearerHeader(teamsOpts(h))).rejects.toThrow(/teams\.cloud\.microsoft: capture returned no header/);
  });

  it('wraps a capture failure with actionable guidance', async () => {
    const h = harness(async () => {
      throw new Error('timed out');
    });
    await expect(captureBearerHeader(teamsOpts(h))).rejects.toThrow(/could not capture a Teams token.*timed out.*signed-in teams\.cloud\.microsoft tab/s);
  });

  it('surfaces the token even when closing the transport fails', async () => {
    const h = harness(async () => FAKE_TOKEN);
    h.close.mockRejectedValueOnce(new Error('already closed'));
    await expect(captureBearerHeader(teamsOpts(h))).resolves.toBe(FAKE_TOKEN);
  });

  it('closes the transport when start() fails, and does not wrap that failure', async () => {
    const h = harness(async () => FAKE_TOKEN);
    h.start.mockRejectedValueOnce(new Error('identity dir unwritable'));
    await expect(captureBearerHeader(teamsOpts(h))).rejects.toThrow(/^identity dir unwritable$/);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('takes a custom normaliser (a non-Bearer header)', async () => {
    const h = harness(async () => `ResyAPI api_key="${'k'.repeat(30)}"`);
    const normalise = (raw: string) => /api_key="([^"]+)"/.exec(raw)?.[1] ?? raw;
    await expect(captureBearerHeader(teamsOpts(h, { normalise, minLength: 20 }))).resolves.toBe('k'.repeat(30));
  });

  it('forwards extra transport options (a debug env var)', async () => {
    const h = harness(async () => FAKE_TOKEN);
    await captureBearerHeader(teamsOpts(h, { transportOptions: { debugEnvVar: 'TEAMS_DEBUG' } }));
    expect(h.createTransport.mock.calls[0]![0]).toMatchObject({ debugEnvVar: 'TEAMS_DEBUG' });
  });
});

describe('captureBearerHeader — several declarations raced (outlook)', () => {
  const CLOUD = { host: 'outlook.cloud.microsoft', path: '/owa/*', headerName: 'authorization' };
  const OFFICE = { host: 'outlook.office.com', path: '/owa/*', headerName: 'authorization' };

  it('resolves with whichever host the tab is on, and declares both', async () => {
    const h = harness((decl) => (decl.host === OFFICE.host ? Promise.resolve(`Bearer ${FAKE_TOKEN}`) : new Promise(() => {})));
    const out = await captureBearerHeader(teamsOpts(h, { captures: [CLOUD, OFFICE], what: 'an Outlook token' }));
    expect(out).toBe(FAKE_TOKEN);
    const opts = h.createTransport.mock.calls[0]![0] as { domains: string[]; captureHeaders: unknown[] };
    expect(opts.domains).toEqual(['outlook.cloud.microsoft', 'outlook.office.com']);
    expect(opts.captureHeaders).toEqual([CLOUD, OFFICE]);
  });

  it('joins every host\'s failure when none succeeds', async () => {
    const h = harness(async (decl) => {
      throw new Error(`${decl.host} said no`);
    });
    const err = (await captureBearerHeader(teamsOpts(h, { captures: [CLOUD, OFFICE], what: 'an Outlook token', guidance: 'G.' })).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('could not capture an Outlook token from the browser (outlook.cloud.microsoft said no; outlook.office.com said no). G.');
  });
});

describe('raceCaptures', () => {
  it('holds the set to ONE overall deadline (the bridge serialises the hosts)', async () => {
    vi.useFakeTimers();
    try {
      const p = raceCaptures([new Promise<string>(() => {}), new Promise<string>(() => {})], 5_000).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(((await p) as Error).message).toBe('timed out after 5s waiting for the page to make a request we could read');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a losing rejection never becomes an unhandled rejection', async () => {
    const out = await raceCaptures([Promise.reject(new Error('no')), Promise.resolve('tok')], 1_000);
    expect(out).toBe('tok');
  });
});

describe('createLazyTransport (fleet-audit#1342)', () => {
  function counting() {
    const transport = { start: vi.fn(async () => {}) };
    const factory = vi.fn(() => transport);
    return { transport, factory };
  }

  it('builds the transport lazily, once', () => {
    const { transport, factory } = counting();
    const lazy = createLazyTransport(factory);
    expect(factory).not.toHaveBeenCalled();
    expect(lazy.transport()).toBe(transport);
    expect(lazy.transport()).toBe(transport);
    expect(factory).toHaveBeenCalledOnce();
    expect(transport.start).not.toHaveBeenCalled();
  });

  it('ready() starts it once, and concurrent callers share the one start', async () => {
    const { transport, factory } = counting();
    const lazy = createLazyTransport(factory);
    const [a, b] = await Promise.all([lazy.ready(), lazy.ready()]);
    expect(a).toBe(transport);
    expect(b).toBe(transport);
    await lazy.ready();
    expect(transport.start).toHaveBeenCalledOnce();
  });

  it('clears a failed start so the next call retries instead of sticking forever', async () => {
    const { transport, factory } = counting();
    transport.start.mockRejectedValueOnce(new Error('EACCES identity dir'));
    const lazy = createLazyTransport(factory);
    await expect(lazy.ready()).rejects.toThrow('EACCES identity dir');
    await expect(lazy.ready()).resolves.toBe(transport);
    expect(transport.start).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledOnce();
  });
});
