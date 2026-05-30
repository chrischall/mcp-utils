import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { createMcpServer, withGracefulShutdown, runMcp } from './index.js';
import type { ToolRegistrar } from './index.js';

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
        { description: 'echo', inputSchema: { msg: z.string() } },
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

describe('runMcp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('connects the provided transport and returns the server', async () => {
    const transport = makeStubTransport();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = await runMcp({
      name: 'x',
      version: '0',
      tools: [],
      transport,
      shutdown: false,
    });
    expect(server).toBeInstanceOf(McpServer);
    expect(transport.started).toBe(1);
    expect(errSpy).not.toHaveBeenCalled();
    await server.close();
  });

  it('prints the banner before connecting', async () => {
    const transport = makeStubTransport();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = await runMcp({
      name: 'x',
      version: '0',
      tools: [],
      banner: 'BANNER',
      transport,
      shutdown: false,
    });
    expect(errSpy).toHaveBeenCalledWith('BANNER');
    await server.close();
  });

  it('passes deps through to registrars', async () => {
    const transport = makeStubTransport();
    const deps = { token: 'abc' };
    const seen: unknown[] = [];
    const reg: ToolRegistrar<typeof deps> = (_s, d) => {
      seen.push(d);
    };
    const server = await runMcp({
      name: 'x',
      version: '0',
      tools: [reg],
      deps,
      transport,
      shutdown: false,
    });
    expect(seen).toEqual([deps]);
    await server.close();
  });

  it('installs graceful shutdown handlers by default', async () => {
    const transport = makeStubTransport();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = process.listenerCount('SIGTERM');
    const server = await runMcp({ name: 'x', version: '0', tools: [], transport });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    await server.close();
  });

  it("defaults transport to 'stdio' when none is given", async () => {
    // Connecting a real StdioServerTransport would grab process stdio; we just
    // assert the default is resolved without throwing by stubbing connect.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const connectSpy = vi
      .spyOn(McpServer.prototype, 'connect')
      .mockResolvedValue(undefined);
    const server = await runMcp({ name: 'x', version: '0', tools: [], shutdown: false });
    expect(connectSpy).toHaveBeenCalledTimes(1);
    // The argument should be a StdioServerTransport-shaped object (has start()).
    const arg = connectSpy.mock.calls[0]![0] as Transport;
    expect(typeof arg.start).toBe('function');
    await server.close();
  });
});
