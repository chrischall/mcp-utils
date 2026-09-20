import { describe, expect, it, vi } from 'vitest';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { surfaceToolHints } from '../server/index.js';
import { currentCallSignal, killOnCancel, throwIfCancelled, withAmbientCancellation, withCallSignal } from './index.js';

/**
 * The caller's cancellation, and the gap it closes.
 *
 * The SDK delivers cancellation properly — `ctx.mcpReq.signal` aborts with
 * the caller's reason — and the fleet ignored it, so a cancelled call kept
 * its HTTP request in flight and kept burning the CPU a hosted child is
 * metered on. claude.ai sent 101 cancellations in the week to 2026-09-20.
 *
 * The tests that matter are the two that fail if the wiring is absent: the
 * signal has to REACH ambient code the handler never passed it to, and it
 * has to abort when the client gives up.
 */
describe('the ambient call signal', () => {
  async function harness(tool: (ctx: unknown) => Promise<unknown>): Promise<{
    client: Client;
    close: () => Promise<void>;
  }> {
    const server = new McpServer({ name: 'cancel-test', version: '0.0.1' });
    surfaceToolHints(server);
    server.registerTool('slow', { description: 'x', inputSchema: z.object({}) }, async (_args, ctx) => {
      await tool(ctx);
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it('reaches code the handler never handed it to, and aborts when the caller gives up', async () => {
    // The whole point: `seen` is read from a helper the tool did not pass
    // anything to, which is how several hundred existing tools call `fetch`.
    let seen: AbortSignal | undefined;
    let abortedDuringCall = false;
    const { client, close } = await harness(async () => {
      seen = currentCallSignal();
      seen?.addEventListener('abort', () => {
        abortedDuringCall = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const controller = new AbortController();
    const call = client.callTool({ name: 'slow', arguments: {} }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller went away')), 50);
    await expect(call).rejects.toThrow(/caller went away/);
    await vi.waitFor(() => expect(abortedDuringCall).toBe(true));

    expect(seen, 'no ambient signal reached the helper').toBeInstanceOf(AbortSignal);
    await close();
  });

  it('is undefined outside a tool call, which is every unit test and every CLI', async () => {
    expect(currentCallSignal()).toBeUndefined();
    // ...and a consumer must read that as "no cancellation", never an error.
    expect(withAmbientCancellation(undefined)).toBeUndefined();
    expect(() => throwIfCancelled()).not.toThrow();
  });
});

describe('combining a signal with the ambient one', () => {
  it('fires when EITHER fires, so neither owner has to know about the other', () => {
    const own = new AbortController();
    const caller = new AbortController();
    withCallSignal(caller.signal, () => {
      const combined = withAmbientCancellation(own.signal);
      expect(combined!.aborted).toBe(false);
      caller.abort(new Error('caller'));
      expect(combined!.aborted, 'the caller aborting did not reach the combined signal').toBe(true);
    });

    const own2 = new AbortController();
    withCallSignal(new AbortController().signal, () => {
      const combined = withAmbientCancellation(own2.signal);
      own2.abort(new Error('timeout'));
      expect(combined!.aborted, 'our own abort did not reach the combined signal').toBe(true);
    });
  });

  it('returns whichever one exists when only one does', () => {
    const own = new AbortController().signal;
    expect(withAmbientCancellation(own)).toBe(own);

    const caller = new AbortController().signal;
    withCallSignal(caller, () => {
      expect(withAmbientCancellation(undefined)).toBe(caller);
    });
  });
});

describe('throwIfCancelled', () => {
  it('throws the signal’s own reason, so the caller sees the error they caused', () => {
    const controller = new AbortController();
    const reason = new Error('caller went away');
    withCallSignal(controller.signal, () => {
      expect(() => throwIfCancelled()).not.toThrow();
      controller.abort(reason);
      expect(() => throwIfCancelled()).toThrow(reason);
    });
  });
});

/**
 * The SUBPROCESS case, which passing a signal to `fetch` does nothing about.
 * A tool that shells out holds a whole process — `gogcli-mcp` runs the `gog`
 * binary this way — so a cancelled call leaves it running to its own
 * timeout, still talking upstream on metered CPU.
 */
describe('killOnCancel', () => {
  function fakeChild(): { kill: (s?: NodeJS.Signals | number) => boolean; killed: (NodeJS.Signals | number | undefined)[] } {
    const killed: (NodeJS.Signals | number | undefined)[] = [];
    return { kill: (s) => (killed.push(s), true), killed };
  }

  it('kills the child when the caller cancels, and stops listening once it settles', () => {
    const controller = new AbortController();
    const child = fakeChild();
    withCallSignal(controller.signal, () => {
      const dispose = killOnCancel(child);
      expect(child.killed).toEqual([]);
      dispose();
      // Disposed BEFORE the abort: a settled child must not be signalled,
      // and a listener that outlives the call is a leak per invocation.
      controller.abort(new Error('caller went away'));
      expect(child.killed, 'a disposed listener still killed the child').toEqual([]);
    });
  });

  it('kills a child whose caller had already gone before it started', () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    const child = fakeChild();
    // Ordinary rather than theoretical: a slow install or a queued spawn
    // puts real time between the cancel and the process existing.
    withCallSignal(controller.signal, () => killOnCancel(child));
    expect(child.killed).toEqual(['SIGTERM']);
  });

  it('does nothing outside a tool call', () => {
    const child = fakeChild();
    const dispose = killOnCancel(child);
    dispose();
    expect(child.killed).toEqual([]);
  });

  it('signals the child when the caller actually goes', () => {
    const controller = new AbortController();
    const child = fakeChild();
    withCallSignal(controller.signal, () => {
      killOnCancel(child);
      controller.abort(new Error('caller went away'));
    });
    expect(child.killed).toEqual(['SIGTERM']);
  });
});
