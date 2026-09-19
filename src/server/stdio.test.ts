/**
 * The stdio boot path, exercised as a real child process over a real pipe.
 *
 * Why a process and not the in-memory harness: the bug this file exists for is
 * `server/discover` answering **Method not found** on every fleet MCP after the
 * SDK v2 migration, and it is invisible to a mock. A hand-wired
 * `server.connect(new StdioServerTransport())` produces a server that is
 * perfectly healthy over an `InMemoryTransport` and perfectly broken over
 * stdio, because the era decision belongs to the serving ENTRY
 * (`serveStdio` / `createMcpHandler`) and not to the instance: an instance
 * nothing marked stays 2025-era, and the 2026-era methods are never installed.
 * Every assertion here therefore goes through `node <fixture>` and the wire.
 *
 * Found by @bschrib in chrischall/skylight-mcp#182.
 *
 * `beforeAll` runs `tsc -b` so the fixture's `dist/` import is never stale —
 * an incremental no-op build is well under a second, and a stale `dist` would
 * let this suite pass against code that no longer exists.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';

const FIXTURE = fileURLToPath(new URL('./stdio-fixture.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TSC = fileURLToPath(new URL('../../node_modules/.bin/tsc', import.meta.url));

/** The modern (2026-07-28) per-request envelope every claim-bearing message carries. */
const MODERN_META = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: 'stdio-test', version: '0' },
};

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** A line-delimited JSON-RPC client over a spawned server's stdio. */
class StdioClient {
  readonly stderr: string[] = [];
  #child: ChildProcessWithoutNullStreams;
  #pending = new Map<number, (response: JsonRpcResponse) => void>();
  #nextId = 1;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.trim() === '') return;
      const message = JSON.parse(line) as JsonRpcResponse;
      if (message.id === undefined) return; // a server-initiated notification
      this.#pending.get(message.id)?.(message);
      this.#pending.delete(message.id);
    });
    createInterface({ input: child.stderr }).on('line', (line) => this.stderr.push(line));
  }

  /**
   * Send one request and await its response. `meta: null` ⇒ a claim-less
   * (2025-era) message — `null` rather than `undefined` because an explicit
   * `undefined` would silently take the modern default and turn every
   * legacy-path assertion into a second modern one.
   */
  request(
    method: string,
    params: Record<string, unknown> = {},
    meta: Record<string, unknown> | null = MODERN_META,
  ): Promise<JsonRpcResponse> {
    const id = this.#nextId++;
    const body = { jsonrpc: '2.0', id, method, params: meta ? { ...params, _meta: meta } : params };
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#child.stdin.write(`${JSON.stringify(body)}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Wait until `predicate` holds over the stderr seen so far (bounded). */
  async stderrSettles(predicate: (lines: string[]) => boolean, ms = 2000): Promise<string[]> {
    const deadline = Date.now() + ms;
    while (!predicate(this.stderr) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.stderr;
  }

  kill(): void {
    this.#child.kill('SIGKILL');
  }

  /** SIGTERM, i.e. the signal `withGracefulShutdown` is supposed to catch. */
  terminate(): void {
    this.#child.kill('SIGTERM');
  }

  /** The child itself, for awaiting its exit code. */
  get child(): ChildProcessWithoutNullStreams {
    return this.#child;
  }
}

let client: StdioClient | undefined;

function start(env: Record<string, string> = {}): StdioClient {
  const child = spawn(process.execPath, [FIXTURE], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  client = new StdioClient(child);
  return client;
}

beforeAll(async () => {
  // Incremental; a no-op when dist/ is current. Keeps the fixture's `dist`
  // import honest without asking the developer to remember `npm run build`.
  await promisify(execFile)(TSC, ['-b'], { cwd: REPO_ROOT });
}, 120_000);

afterEach(() => {
  client?.kill();
  client = undefined;
});

// Generous per-test timeout: every case spawns a Node process, and the first
// spawn of a cold run has been seen past vitest's 5s default.
describe('runMcp over real stdio', () => {
  it('answers server/discover — the 2026-era discovery a hand-wired connect never installs', async () => {
    const mcp = start();
    const discover = await mcp.request('server/discover');
    expect(discover.error).toBeUndefined();
    expect(discover.result).toBeDefined();
  });

  it('lists the registered tools to a modern client', async () => {
    const mcp = start();
    await mcp.request('server/discover');
    const listed = await mcp.request('tools/list');
    expect(listed.error).toBeUndefined();
    const tools = listed.result?.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('calls a tool, threading the deps built once at boot', async () => {
    const mcp = start();
    await mcp.request('server/discover');
    const called = await mcp.request('tools/call', { name: 'echo', arguments: { msg: 'world' } });
    expect(called.error).toBeUndefined();
    const content = called.result?.content as { text: string }[];
    expect(content[0]!.text).toMatch(/^hello world \d+$/);
  });

  // `legacy: 'serve'` is the default for exactly this reason: a 2025-era host
  // opens with a claim-less `initialize`, and 'reject' would drop it.
  it('still serves a 2025-era initialize opening', async () => {
    const mcp = start();
    const initialized = await mcp.request(
      'initialize',
      { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'old', version: '0' } },
      null,
    );
    expect(initialized.error).toBeUndefined();
    expect(initialized.result?.protocolVersion).toBe('2025-11-25');
    mcp.notify('notifications/initialized');
    const listed = await mcp.request('tools/list', {}, null);
    expect((listed.result?.tools as { name: string }[]).map((t) => t.name)).toEqual(['echo']);
  });

  it('prints the banner once at boot, before any client connects', async () => {
    const mcp = start();
    const lines = await mcp.stderrSettles((l) => l.includes('fixture-mcp banner'));
    expect(lines.filter((l) => l === 'fixture-mcp banner')).toHaveLength(1);
    // Nothing has opened the connection yet, so no instance exists.
    expect(lines).not.toContain('fixture:registrars-ran');
  });

  // The contract callers must know: the factory runs PER INSTANCE, and a
  // client that probes with `server/discover` and then falls back to
  // `initialize` makes two. Anything expensive or credential-bearing belongs
  // outside it — which is why `deps` is built at boot and shared.
  it('re-runs the registrars when a modern probe falls back to a legacy opening', async () => {
    const mcp = start();
    await mcp.request('server/discover');
    await mcp.stderrSettles((l) => l.filter((x) => x === 'fixture:registrars-ran').length >= 1);

    const initialized = await mcp.request(
      'initialize',
      { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'old', version: '0' } },
      null,
    );
    expect(initialized.error).toBeUndefined();

    const lines = await mcp.stderrSettles(
      (l) => l.filter((x) => x === 'fixture:registrars-ran').length >= 2,
    );
    expect(lines.filter((l) => l === 'fixture:registrars-ran')).toHaveLength(2);
    // One boot, one banner, however many instances.
    expect(lines.filter((l) => l === 'fixture-mcp banner')).toHaveLength(1);

    // The deps object is the same one both instances were handed.
    const called = await mcp.request('tools/call', { name: 'echo', arguments: { msg: 'x' } }, null);
    expect((called.result?.content as { text: string }[])[0]!.text).toMatch(/^hello x \d+$/);
  });

  // `withGracefulShutdown` now closes the StdioServerHandle rather than an
  // McpServer. A signal that reached default handling would exit with a null
  // code and the signal name, so `0` is the proof the handler ran.
  it('exits cleanly on SIGTERM, through the handle graceful shutdown closes', async () => {
    // Wait for the BANNER rather than sleeping a fixed 300ms. The sleep raced
    // the child's own boot: signal before `withGracefulShutdown` has installed
    // its handlers and SIGTERM reaches default handling, which exits with a
    // null code and the signal name. That fails loudly rather than silently,
    // so the old shape was not wrong — but it was timing, not evidence, and it
    // was one loaded machine away from flaking. `runMcp` prints the banner
    // after the handlers are installed, so it is the earliest moment at which
    // this assertion means anything.
    const mcp = start();
    await mcp.stderrSettles((lines) => lines.includes('fixture-mcp banner'));
    mcp.terminate();
    const [code] = (await once(mcp.child, 'exit')) as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
  });

  // `legacy` is a new public option and this is the branch that turns hosts
  // away; the default `'serve'` is covered by the legacy-era cases above.
  // Without this, half of a public option ships unexercised.
  it("refuses a 2025-era opening when legacy is 'reject', and stays open after", async () => {
    const mcp = start({ FIXTURE_LEGACY: 'reject' });
    await mcp.stderrSettles((lines) => lines.includes('fixture-mcp banner'));

    // `meta: null` is the claim-less (2025) opening, and is deliberate: an
    // explicit `undefined` would take the modern default and quietly turn this
    // into a second modern-path assertion.
    const refused = await mcp.request(
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-probe', version: '0' } },
      null,
    );
    expect(refused.error).toBeDefined();
    expect(refused.result).toBeUndefined();

    // The documented half a refusal test usually forgets: the connection is
    // supposed to STAY OPEN for a modern opening rather than being torn down.
    const listed = await mcp.request('tools/list');
    expect(listed.error).toBeUndefined();
    expect((listed.result?.tools as unknown[]).length).toBeGreaterThan(0);
  });
}, 30_000);
