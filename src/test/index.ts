/**
 * `@chrischall/mcp-utils/test` — the in-memory vitest harness shared by every
 * MCP in the fleet. Devtime-only: this subpath pulls test scaffolding and is
 * never imported by runtime server code.
 *
 * It consolidates four copy-pasted pieces from ~19 sibling repos:
 *  - `createTestHarness` / `parseToolResult` — a connected `McpServer` + `Client`
 *    pair over `InMemoryTransport`, plus the trivial JSON-body extractor.
 *  - `versionSyncTest` — the release-please drift guard (`x-release-please-version`
 *    annotations vs `package.json#version`).
 *  - `mockFetchproxyBootstrap` / `setupClientMocks` — mock `@fetchproxy/bootstrap`
 *    at the module boundary and spy an API client's request methods.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Mock } from 'vitest';

/** A function that registers one or more tools onto a fresh `McpServer`. */
export type RegisterFn = (server: McpServer) => void | Promise<void>;

/** The connected test harness returned by {@link createTestHarness}. */
export interface TestHarness {
  /** The MCP client side of the in-memory transport pair. */
  client: Client;
  /** The MCP server the `registerFn` was applied to. */
  server: McpServer;
  /** Call a registered tool by name; arguments default to `{}`. */
  callTool: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  /** List the tools the server advertises (name only). */
  listTools: () => Promise<{ name: string }[]>;
  /** Tear down both ends of the transport. Safe to call more than once. */
  close: () => Promise<void>;
}

/**
 * Create a connected `McpServer` + `Client` pair wired over
 * `InMemoryTransport`. The byte-identical helper every MCP's `tests/helpers.ts`
 * defines — register your tools, then drive them through the real client RPC
 * path (schema validation, content envelopes, isError, and all).
 */
export async function createTestHarness(registerFn: RegisterFn): Promise<TestHarness> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  await registerFn(server);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  let closed = false;
  return {
    client,
    server,
    callTool: (name, args) =>
      client.callTool({ name, arguments: args ?? {} }) as Promise<CallToolResult>,
    listTools: async () => {
      const result = await client.listTools();
      return result.tools.map((t) => ({ name: t.name }));
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close();
      await server.close();
    },
  };
}

/**
 * Parse the JSON body out of a tool's `CallToolResult`. Fleet tools return a
 * single text block of `JSON.stringify(data, null, 2)`; this is the inverse.
 * Throws a contextual error (rather than a bare `TypeError`/`SyntaxError`) when
 * the result is empty, non-text, or not valid JSON — those are the test
 * failures you actually want to read.
 */
export function parseToolResult<T = unknown>(result: CallToolResult): T {
  const block = result.content?.[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error(
      `parseToolResult: result has no text content block (got ${
        block ? `type='${block.type}'` : 'empty content'
      })`,
    );
  }
  try {
    return JSON.parse(block.text) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`parseToolResult: text block is not valid JSON (${reason}): ${block.text}`);
  }
}

/** Options for {@link versionSyncTest}. */
export interface VersionSyncOptions {
  /** Directory to walk for `.ts` files (typically `<repo>/src`). */
  srcDir: string;
  /** Path to the `package.json` whose `version` is the source of truth. */
  pkgPath: string;
}

const SEMVER_LITERAL = /['"]([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?)['"]/;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * The release-please drift guard. Walks `srcDir` for every line carrying an
 * `x-release-please-version` annotation and asserts the version literal on that
 * line matches `package.json#version`.
 *
 * Why this exists: a recurring footgun where a `VERSION` constant (the MCP's
 * self-reported version + fetchproxy bridge identity) silently drifts from
 * `package.json` because release-please's `extra-files` registration lacks the
 * marker. resy-mcp v0.2.0 and opentable-mcp shipped this bug repeatedly.
 *
 * Returns the list of mismatch descriptions (`file:line → found (expected X)`).
 * An empty array means in sync — callers assert `expect(result).toEqual([])`.
 * Marker lines with no version literal (e.g. a docstring describing the
 * convention) are intentionally skipped, so the test never trips on itself.
 */
export function versionSyncTest({ srcDir, pkgPath }: VersionSyncOptions): string[] {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  const root = join(srcDir, '..');
  const mismatches: string[] = [];
  for (const f of walkTs(srcDir)) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('x-release-please-version')) return;
      const match = line.match(SEMVER_LITERAL);
      if (!match) return;
      const ver = match[1];
      if (ver !== pkg.version) {
        mismatches.push(`${relative(root, f)}:${i + 1} → ${ver} (expected ${pkg.version})`);
      }
    });
  }
  return mismatches;
}

/**
 * The shape `@fetchproxy/bootstrap`'s `bootstrap()` resolves to: extracted
 * browser state keyed by name. Mirrored here (rather than imported) because the
 * bootstrap package is an optional, browser-side dep that consumers mock at the
 * module boundary — the harness must not pull it.
 */
export interface BootstrapResult {
  /** Cookie name → value. */
  cookies: Record<string, string>;
  /** `localStorage` key → value. */
  localStorage: Record<string, string>;
  /** `sessionStorage` key → value. */
  sessionStorage: Record<string, string>;
  /** Request headers captured during the bootstrap navigation. */
  capturedHeaders: Record<string, string>;
}

/**
 * Build a fully-shaped {@link BootstrapResult}, with empty maps as defaults and
 * `overrides` shallow-merged on top. Keeps tests from re-declaring the four
 * empty maps every time they only care about, say, `cookies`.
 */
export function makeBootstrapResult(overrides: Partial<BootstrapResult> = {}): BootstrapResult {
  return {
    cookies: {},
    localStorage: {},
    sessionStorage: {},
    capturedHeaders: {},
    ...overrides,
  };
}

/** Handle returned by {@link mockFetchproxyBootstrap}. */
export interface FetchproxyBootstrapMock {
  /** The spy standing in for `bootstrap()`. Assert/override per test. */
  bootstrap: Mock<(...args: unknown[]) => Promise<BootstrapResult>>;
  /**
   * A module factory matching `@fetchproxy/bootstrap`'s export surface — pass
   * to `vi.mock('@fetchproxy/bootstrap', mock.module)`.
   */
  module: () => { bootstrap: (...args: unknown[]) => Promise<BootstrapResult> };
  /** Clear recorded calls and restore the default resolved value. */
  reset: () => void;
}

/**
 * Mock `@fetchproxy/bootstrap` at the module boundary so tests never open a
 * real WebSocket to a browser bridge. Returns a spy that resolves a default
 * {@link BootstrapResult} (overridable per call via `bootstrap.mockResolvedValue`).
 *
 * Usage:
 * ```ts
 * const fp = mockFetchproxyBootstrap({ cookies: { SID: 'x' } });
 * vi.mock('@fetchproxy/bootstrap', fp.module);
 * // ...import the SUT, then assert on fp.bootstrap
 * ```
 * Because `vi.mock` is hoisted, declare the mock handle and the `vi.mock` call
 * before importing the system under test.
 */
export function mockFetchproxyBootstrap(
  defaultResult: Partial<BootstrapResult> = {},
): FetchproxyBootstrapMock {
  const base = makeBootstrapResult(defaultResult);
  const bootstrap = vi.fn(async (..._args: unknown[]) => base) as Mock<
    (...args: unknown[]) => Promise<BootstrapResult>
  >;
  return {
    bootstrap,
    module: () => ({ bootstrap: (...args: unknown[]) => bootstrap(...args) }),
    reset: () => {
      bootstrap.mockReset();
      bootstrap.mockResolvedValue(base);
    },
  };
}

/**
 * Spy on an API client's async request methods and (optionally) stub each one's
 * resolved value. Mirrors the `vi.spyOn(client, 'request').mockResolvedValue(...)`
 * boilerplate every tool-level test repeats.
 *
 * For each entry in `returns`: a spy is installed on `client[method]`. If the
 * value is `undefined`, the spy passes through to the real implementation;
 * otherwise it `mockResolvedValue`s the provided value. Remember to
 * `vi.restoreAllMocks()` in `afterEach`.
 *
 * @returns A map of method name → installed spy, for call assertions.
 */
export function setupClientMocks<C extends object>(
  client: C,
  returns: Partial<Record<keyof C & string, unknown>>,
): Record<string, Mock> {
  const spies: Record<string, Mock> = {};
  for (const method of Object.keys(returns) as (keyof C & string)[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(client as any, method) as unknown as Mock;
    const value = returns[method];
    if (value !== undefined) spy.mockResolvedValue(value as never);
    spies[method] = spy;
  }
  return spies;
}
