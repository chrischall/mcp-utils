import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import {
  McpServer,
  InMemoryTransport,
  ProtocolErrorCode,
  UrlElicitationRequiredError,
} from '@modelcontextprotocol/server';
import type { Transport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  createMcpServer,
  SERVER_PROTOCOL_VERSIONS,
  withGracefulShutdown,
  runMcp,
} from './index.js';
import { McpToolError } from '../errors/index.js';
import type { RunMcpOptions, ToolRegistrar } from './index.js';

/** A sp-able stub Transport that records start/close. */
function makeStubTransport(): Transport & { started: number; closed: number } {
  return {
    started: 0,
    closed: 0,
    async start() {
      this.started++;
    },
    async send() {
      /* no-op */
    },
    async close() {
      this.closed++;
    },
  };
}

/**
 * Boot through `runMcp` over the server half of an in-memory pair and connect
 * a real {@link Client} to the other half.
 *
 * In-memory is the right tool for "did the registrars see `deps`" and "does a
 * client get served at all"; it is the WRONG tool for anything about the
 * protocol era, which is why `stdio.test.ts` spawns a process instead.
 */
async function servedPair<TDeps>(opts: Omit<RunMcpOptions<TDeps>, 'transport'>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  const handle = runMcp({ ...opts, transport: serverTransport } as RunMcpOptions<TDeps>);
  await client.connect(clientTransport);
  return {
    client,
    handle,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

describe('createMcpServer', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('returns an McpServer with the given name/version', async () => {
    const server = await createMcpServer({ name: 'x-mcp', version: '1.2.3', tools: [] });
    expect(server).toBeInstanceOf(McpServer);
  });

  it('exports the 2026-07-28 protocol used by production and the harness', () => {
    expect(SERVER_PROTOCOL_VERSIONS).toContain('2026-07-28');
  });

  it('runs every ToolRegistrar with the server and deps', async () => {
    const deps = { client: { id: 7 } };
    const calls: Array<{ server: McpServer; deps: unknown }> = [];
    const reg: ToolRegistrar<typeof deps> = (server, d) => {
      calls.push({ server, deps: d });
    };
    const server = await createMcpServer({
      name: 'x',
      version: '0.0.0',
      tools: [reg, reg],
      deps,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.server).toBe(server);
    expect(calls[0]!.deps).toBe(deps);
  });

  it('does NOT connect a transport (caller / runMcp owns connect)', async () => {
    const transport = makeStubTransport();
    await createMcpServer({ name: 'x', version: '0', tools: [], transport });
    expect(transport.started).toBe(0);
  });

  it('prints the banner to stderr when given', async () => {
    await createMcpServer({ name: 'x', version: '0', tools: [], banner: 'hello-banner' });
    expect(errSpy).toHaveBeenCalledWith('hello-banner');
  });

  it('does not print to stderr when no banner is given', async () => {
    await createMcpServer({ name: 'x', version: '0', tools: [] });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('registers tools that are then callable through a real client', async () => {
    const reg: ToolRegistrar = (server) => {
      server.registerTool(
        'echo',
        { description: 'echo', inputSchema: z.object({ msg: z.string() }) },
        async ({ msg }) => ({ content: [{ type: 'text', text: String(msg) }] }),
      );
    };
    const server = await createMcpServer({ name: 'x', version: '0', tools: [reg] });
    const client = new Client({ name: 'c', version: '0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = (await client.callTool({ name: 'echo', arguments: { msg: 'hi' } })) as {
      content: { type: string; text: string }[];
    };
    expect(result.content[0]!.text).toBe('hi');
    await client.close();
    await server.close();
  });

  describe('maxToolInputElements', () => {
    const countReg: ToolRegistrar = (server) => {
      server.registerTool(
        'count',
        { description: 'count', inputSchema: z.object({ items: z.array(z.number()) }) },
        async ({ items }) => ({ content: [{ type: 'text', text: String(items.length) }] }),
      );
    };
    async function callCount(server: McpServer, n: number) {
      const client = new Client({ name: 'c', version: '0' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      try {
        return (await client.callTool({ name: 'count', arguments: { items: Array.from({ length: n }, (_, i) => i) } })) as {
          isError?: boolean;
          content: { type: string; text: string }[];
        };
      } finally {
        await client.close();
        await server.close();
      }
    }

    it('refuses a call whose arguments exceed the limit, as a tool error', async () => {
      const server = await createMcpServer({ name: 'x', version: '0', tools: [countReg], maxToolInputElements: 10 });
      const result = await callCount(server, 50);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).not.toBe('50');
    });

    it('serves a call within the limit', async () => {
      const server = await createMcpServer({ name: 'x', version: '0', tools: [countReg], maxToolInputElements: 100 });
      const result = await callCount(server, 50);
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toBe('50');
    });

    it('is off when omitted, as in the SDK', async () => {
      const server = await createMcpServer({ name: 'x', version: '0', tools: [countReg] });
      const result = await callCount(server, 5000);
      expect(result.content[0]!.text).toBe('5000');
    });

    it('rejects an invalid limit at construction', async () => {
      await expect(createMcpServer({ name: 'x', version: '0', tools: [], maxToolInputElements: 0 })).rejects.toThrow();
    });
  });

  it('supports async ToolRegistrars (awaits them before resolving)', async () => {
    let done = false;
    const reg: ToolRegistrar = async () => {
      await new Promise((r) => setTimeout(r, 1));
      done = true;
    };
    await createMcpServer({ name: 'x', version: '0', tools: [reg] });
    expect(done).toBe(true);
  });
});

describe('withGracefulShutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('registers SIGINT and SIGTERM handlers', async () => {
    const server = await createMcpServer({ name: 'x', version: '0', tools: [] });
    const before = process.listenerCount('SIGINT');
    withGracefulShutdown(server, { exit: false });
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    expect(process.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(1);
  });

  it('closes the server and runs onSignal on SIGINT', async () => {
    const server = await createMcpServer({ name: 'x', version: '0', tools: [] });
    const closeSpy = vi.spyOn(server, 'close').mockResolvedValue(undefined);
    const onSignal = vi.fn(async () => undefined);
    withGracefulShutdown(server, { onSignal, exit: false });
    process.emit('SIGINT');
    // allow the async handler to run
    await new Promise((r) => setImmediate(r));
    expect(onSignal).toHaveBeenCalledWith('SIGINT');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('calls process.exit(0) by default after cleanup', async () => {
    const server = await createMcpServer({ name: 'x', version: '0', tools: [] });
    vi.spyOn(server, 'close').mockResolvedValue(undefined);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    withGracefulShutdown(server);
    process.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('still exits (cleanly) when onSignal throws', async () => {
    const server = await createMcpServer({ name: 'x', version: '0', tools: [] });
    vi.spyOn(server, 'close').mockResolvedValue(undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    withGracefulShutdown(server, { onSignal: async () => {
      throw new Error('boom');
    } });
    process.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(errSpy).toHaveBeenCalled();
  });

  it('is idempotent: a second signal does not re-run shutdown', async () => {
    const server = await createMcpServer({ name: 'x', version: '0', tools: [] });
    const closeSpy = vi.spyOn(server, 'close').mockResolvedValue(undefined);
    withGracefulShutdown(server, { exit: false });
    process.emit('SIGINT');
    process.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

// SDK 2.1 closes the stdio transport on stdin EOF, but a process holding a
// bridge socket stays alive unless shutdown runs `onSignal` on EOF too.
describe('withGracefulShutdown — stdin EOF', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it("runs onSignal('stdin-eof'), closes, and exits once when the stream ends", async () => {
    const stdin = new PassThrough();
    const target = { close: vi.fn(async () => undefined) };
    const onSignal = vi.fn(async () => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    withGracefulShutdown(target, { onSignal, stdin });
    stdin.resume(); // flowing, as the transport's 'data' listener makes it
    stdin.end();
    await new Promise((r) => setTimeout(r, 10)); // 'end' then 'close' both fire
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal).toHaveBeenCalledWith('stdin-eof');
    expect(target.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('an EOF during a stuck signal-driven shutdown does not force an early exit', async () => {
    vi.useFakeTimers();
    const stdin = new PassThrough();
    const target = { close: () => new Promise<void>(() => {}) };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    withGracefulShutdown(target, { stdin, timeoutMs: 60_000 });
    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(1000); // well past the repeat-signal grace window
    stdin.emit('end');
    stdin.emit('close');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('ignores stdin entirely when no stream is given', async () => {
    const target = { close: vi.fn(async () => undefined) };
    const endListeners = process.stdin.listenerCount('end');
    withGracefulShutdown(target, { exit: false });
    expect(process.stdin.listenerCount('end')).toBe(endListeners);
  });
});

// audit 2026-09 (BUG-4): a wedged cleanup must not hang the process forever.
describe('withGracefulShutdown — bounded cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('exits after the cleanup timeout when onSignal never settles', async () => {
    vi.useFakeTimers();
    const target = { close: vi.fn(async () => undefined) };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    withGracefulShutdown(target, { onSignal: () => new Promise<void>(() => {}), timeoutMs: 1000 });
    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(999);
    expect(exitSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults to a 5s cleanup bound when close() never settles', async () => {
    vi.useFakeTimers();
    const target = { close: () => new Promise<void>(() => {}) };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    withGracefulShutdown(target);
    process.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(5000);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('a second signal after the grace window during a stuck shutdown forces an immediate exit', async () => {
    vi.useFakeTimers();
    const target = { close: () => new Promise<void>(() => {}) };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    withGracefulShutdown(target, { timeoutMs: 60_000 });
    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(500);
    expect(exitSpy).not.toHaveBeenCalled();
    process.emit('SIGTERM');
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores a repeat signal inside the default 500ms grace window (npx double SIGINT) and still cleans up', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const onSignal = vi.fn(() => new Promise<void>((r) => (release = r)));
    const target = { close: vi.fn(async () => undefined) };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    withGracefulShutdown(target, { onSignal, timeoutMs: 60_000 });
    process.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(10);
    process.emit('SIGINT'); // the duplicate npx delivers for one Ctrl-C
    await vi.advanceTimersByTimeAsync(489);
    process.emit('SIGINT');
    expect(exitSpy).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(target.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('honours a custom repeatSignalGraceMs', async () => {
    vi.useFakeTimers();
    const target = { close: () => new Promise<void>(() => {}) };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    withGracefulShutdown(target, { timeoutMs: 60_000, repeatSignalGraceMs: 2000 });
    process.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(1999);
    process.emit('SIGINT');
    expect(exitSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    process.emit('SIGINT');
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('repeatSignalGraceMs: 0 restores the immediate second-signal exit', async () => {
    vi.useFakeTimers();
    const target = { close: () => new Promise<void>(() => {}) };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    withGracefulShutdown(target, { timeoutMs: 60_000, repeatSignalGraceMs: 0 });
    process.emit('SIGINT');
    process.emit('SIGINT');
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('exits once, not twice, when cleanup finishes in time', async () => {
    vi.useFakeTimers();
    const target = { close: vi.fn(async () => undefined) };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    withGracefulShutdown(target, { timeoutMs: 1000 });
    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(5000);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});

describe('runMcp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('passes maxToolInputElements to the server it builds', async () => {
    const reg: ToolRegistrar = (server) => {
      server.registerTool(
        'count',
        { description: 'count', inputSchema: z.object({ items: z.array(z.number()) }) },
        async ({ items }) => ({ content: [{ type: 'text', text: String(items.length) }] }),
      );
    };
    const pair = await servedPair({ name: 'x', version: '0', tools: [reg], shutdown: false, maxToolInputElements: 10 });
    try {
      const result = (await pair.client.callTool({ name: 'count', arguments: { items: Array.from({ length: 50 }, (_, i) => i) } })) as {
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it('starts the provided transport and returns the stdio handle', async () => {
    const transport = makeStubTransport();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = runMcp({
      name: 'x',
      version: '0',
      tools: [],
      transport,
      shutdown: false,
    });
    expect(typeof handle.close).toBe('function');
    expect(transport.started).toBe(1);
    expect(errSpy).not.toHaveBeenCalled();
    await handle.close();
    expect(transport.closed).toBe(1);
  });

  // `await` on a non-promise is legal, and every one of the 60 fleet
  // consumers writes `await runMcp({...})` and discards the result — so the
  // return-type change is source-compatible and this is the case that says so.
  it('is still awaitable, as every fleet entrypoint writes it', async () => {
    const transport = makeStubTransport();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await runMcp({ name: 'x', version: '0', tools: [], transport, shutdown: false });
    expect(transport.started).toBe(1);
    await handle.close();
  });

  // The banner belongs to the BOOT, not to an instance: the factory can run
  // more than once for one connection (probe → legacy fallback), and a banner
  // inside it would print once per instance.
  it('prints the banner once at boot, before any instance exists', async () => {
    const transport = makeStubTransport();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: unknown[] = [];
    const handle = runMcp({
      name: 'x',
      version: '0',
      tools: [() => void seen.push('registered')],
      banner: 'BANNER',
      transport,
      shutdown: false,
    });
    expect(errSpy).toHaveBeenCalledExactlyOnceWith('BANNER');
    expect(seen).toEqual([]); // nothing opened the connection, so no factory run
    await handle.close();
  });

  it('passes deps through to the registrars of every instance it builds', async () => {
    const deps = { token: 'abc' };
    const seen: unknown[] = [];
    const reg: ToolRegistrar<typeof deps> = (_s, d) => {
      seen.push(d);
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client, handle, close } = await servedPair({
      name: 'x',
      version: '0',
      tools: [reg],
      deps,
      shutdown: false,
    });
    await client.listTools();
    expect(seen).toEqual([deps]);
    expect(handle).toBeDefined();
    await close();
  });

  it('installs graceful shutdown handlers by default', async () => {
    const transport = makeStubTransport();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = process.listenerCount('SIGTERM');
    const handle = runMcp({ name: 'x', version: '0', tools: [], transport });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    await handle.close();
  });

  it("defaults transport to 'stdio' — a real stdio transport over this process", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = process.stdin.listenerCount('data');
    const handle = runMcp({ name: 'x', version: '0', tools: [], shutdown: false });
    // serveStdio built and started a StdioServerTransport over process.stdio.
    expect(process.stdin.listenerCount('data')).toBe(before + 1);
    await handle.close();
    expect(process.stdin.listenerCount('data')).toBe(before);
  });

  it('serves 2025-era openings by default, rather than rejecting them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client, close } = await servedPair({ name: 'x', version: '0', tools: [], shutdown: false });
    // `Client.connect` performs the 2025 initialize handshake; under
    // `legacy: 'reject'` it would be answered with the
    // unsupported-protocol-version error instead.
    expect(client.getServerVersion()).toEqual({ name: 'x', version: '0' });
    await close();
  });

  it('reports an out-of-band error to onerror rather than swallowing it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errors: Error[] = [];
    const transport = makeStubTransport();
    const handle = runMcp({
      name: 'x',
      version: '0',
      tools: [
        () => {
          throw new Error('registrar exploded');
        },
      ],
      transport,
      shutdown: false,
      onerror: (err) => errors.push(err),
    });
    // Drive one opening message through the wire the entry is pumping.
    transport.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.message).toContain('registrar exploded');
    await handle.close();
  });
});

describe('tool error hints', () => {
  /** Connect a server built by createMcpServer to an in-memory client. */
  async function harness(register: ToolRegistrar<undefined>, surfaceHints?: boolean) {
    const server = await createMcpServer<undefined>({
      name: 't',
      version: '0',
      tools: [register],
      ...(surfaceHints === undefined ? {} : { surfaceHints }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return { client, close: () => Promise.all([client.close(), server.close()]) };
  }

  const textOf = (result: unknown) =>
    ((result as { content: { text: string }[] }).content[0]?.text ?? '');

  it('appends the hint of an McpToolError rejected asynchronously', async () => {
    const { client, close } = await harness((s) =>
      void s.registerTool('t', { inputSchema: z.object({ a: z.string() }) }, async () => {
        throw new McpToolError('no such option 999', { hint: 'Available: 1 (Bus), 2 (Walker)' });
      }),
    );
    const result = await client.callTool({ name: 't', arguments: { a: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('no such option 999\n\nHint: Available: 1 (Bus), 2 (Walker)');
    await close();
  });

  it('appends the hint of an McpToolError thrown synchronously', async () => {
    const { client, close } = await harness((s) =>
      void s.registerTool('t', {}, (() => {
        throw new McpToolError('bad', { hint: 'do the thing' });
      }) as never),
    );
    expect(textOf(await client.callTool({ name: 't' }))).toBe('bad\n\nHint: do the thing');
    await close();
  });

  // A tool with no inputSchema is called back as `(extra)` rather than
  // `(args, extra)`; the wrapper forwards whatever arrived, so both work.
  it('leaves a zero-argument tool callable', async () => {
    const { client, close } = await harness((s) =>
      void s.registerTool('t', {}, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
    );
    expect(textOf(await client.callTool({ name: 't' }))).toBe('ok');
    await close();
  });

  it('passes a tool with an inputSchema its arguments unchanged', async () => {
    const seen: unknown[] = [];
    const { client, close } = await harness((s) =>
      void s.registerTool('t', { inputSchema: z.object({ a: z.string() }) }, async (args) => {
        seen.push(args);
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      }),
    );
    await client.callTool({ name: 't', arguments: { a: 'hello' } });
    expect(seen).toEqual([{ a: 'hello' }]);
    await close();
  });

  it('leaves an McpToolError with no hint as the bare message', async () => {
    const { client, close } = await harness((s) =>
      void s.registerTool('t', {}, async () => {
        throw new McpToolError('just this');
      }),
    );
    expect(textOf(await client.callTool({ name: 't' }))).not.toContain('Hint:');
    await close();
  });

  // An unexpected error keeps its own message, so a genuine bug still reads as
  // one rather than being flattened into advice.
  it('renders a non-McpToolError as its bare message', async () => {
    const { client, close } = await harness((s) =>
      void s.registerTool('t', {}, async () => {
        throw new TypeError('undefined is not a function');
      }),
    );
    const result = await client.callTool({ name: 't' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('undefined is not a function');
    expect(textOf(result)).not.toContain('Hint:');
    await close();
  });

  // Fleet audit library-candidates §16: the wrapper used to rethrow anything
  // that was not an McpToolError, and the SDK then rendered its raw `message`
  // — so a URL-quoting TypeError or a third-party client error reached the
  // caller with its token intact. Every thrown error now crosses the same
  // redaction boundary `errorResult` applies.
  it('redacts a secret in a non-McpToolError message', async () => {
    const { client, close } = await harness((s) =>
      void s.registerTool('t', {}, async () => {
        throw new Error('GET https://h.example/f?verifier=FAKEverif0123456789 failed: Authorization: Bearer FAKEtok0123456789');
      }),
    );
    const result = await client.callTool({ name: 't' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('FAKEverif0123456789');
    expect(textOf(result)).not.toContain('FAKEtok0123456789');
    expect(textOf(result)).toContain('GET https://h.example/f?verifier=[REDACTED] failed');
    await close();
  });

  it('redacts a secret in a synchronously thrown non-Error value', async () => {
    const { client, close } = await harness((s) =>
      void s.registerTool('t', {}, (() => {
        throw 'bad redirect to /cb?access_token=FAKEacc0123456789';
      }) as never),
    );
    const result = await client.callTool({ name: 't' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('bad redirect to /cb?access_token=[REDACTED]');
    await close();
  });

  it('redacts a secret in an McpToolError with no hint', async () => {
    const { client, close } = await harness((s) =>
      void s.registerTool('t', {}, async () => {
        throw new McpToolError('upstream said {"password":"FAKEpw0123456789"}');
      }),
    );
    expect(textOf(await client.callTool({ name: 't' }))).toBe('upstream said {"password":"[REDACTED]"}');
    await close();
  });

  // The SDK's tools/call handler rethrows exactly this one protocol error so
  // the client receives a JSON-RPC error it can act on (open the URL); turning
  // it into a tool result would break URL-mode elicitation.
  it('still propagates a UrlElicitationRequiredError as a protocol error', async () => {
    const { client, close } = await harness((s) =>
      void s.registerTool('t', {}, async () => {
        throw new UrlElicitationRequiredError([
          { mode: 'url', message: 'sign in', url: 'https://h.example/login', elicitationId: 'e1' },
        ]);
      }),
    );
    await expect(client.callTool({ name: 't' })).rejects.toMatchObject({
      code: ProtocolErrorCode.UrlElicitationRequired,
    });
    await close();
  });

  it('can be opted out of', async () => {
    const { client, close } = await harness(
      (s) =>
        void s.registerTool('t', {}, async () => {
          throw new McpToolError('bad', { hint: 'do the thing' });
        }),
      false,
    );
    expect(textOf(await client.callTool({ name: 't' }))).not.toContain('Hint:');
    await close();
  });

  it('is on by default through runMcp too', async () => {
    // runMcp owns the transport, so hand it the server half of the pair rather
    // than connecting a second one afterwards.
    const { client, close } = await servedPair<undefined>({
      name: 't',
      version: '0',
      shutdown: false,
      tools: [
        (s) =>
          void s.registerTool('t', {}, async () => {
            throw new McpToolError('bad', { hint: 'do the thing' });
          }),
      ],
    });
    expect(textOf(await client.callTool({ name: 't' }))).toContain('Hint: do the thing');
    await close();
  });
});

describe('withGracefulShutdown — option validation', () => {
  it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY]])('rejects repeatSignalGraceMs %s', (t) => {
    expect(() =>
      withGracefulShutdown({ close: async () => undefined }, { exit: false, repeatSignalGraceMs: t }),
    ).toThrow(RangeError);
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])('rejects timeoutMs %s', (t) => {
    expect(() => withGracefulShutdown({ close: async () => undefined }, { exit: false, timeoutMs: t })).toThrow(
      RangeError,
    );
  });
});
