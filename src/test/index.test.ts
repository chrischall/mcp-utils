import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createTestHarness,
  parseToolResult,
  versionSyncTest,
  mockFetchproxyBootstrap,
  setupClientMocks,
  makeBootstrapResult,
} from './index.js';

/** Register a couple of trivial tools onto a server for harness tests. */
function registerEcho(server: McpServer): void {
  server.registerTool(
    'echo',
    {
      description: 'echo back json',
      inputSchema: { value: z.string() },
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify({ echoed: args.value }, null, 2) }],
    }),
  );
  server.registerTool(
    'ping',
    { description: 'ping' },
    async () => ({ content: [{ type: 'text', text: '"pong"' }] }),
  );
}

describe('createTestHarness', () => {
  it('connects a client/server pair and lists registered tools', async () => {
    const h = await createTestHarness(registerEcho);
    try {
      const tools = await h.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['echo', 'ping']);
    } finally {
      await h.close();
    }
  });

  it('callTool round-trips arguments through the in-memory transport', async () => {
    const h = await createTestHarness(registerEcho);
    try {
      const res = await h.callTool('echo', { value: 'hello' });
      expect(parseToolResult<{ echoed: string }>(res)).toEqual({ echoed: 'hello' });
    } finally {
      await h.close();
    }
  });

  it('callTool defaults arguments to an empty object', async () => {
    const h = await createTestHarness(registerEcho);
    try {
      const res = await h.callTool('ping');
      expect(parseToolResult<string>(res)).toBe('pong');
    } finally {
      await h.close();
    }
  });

  it('exposes the underlying client and server instances', async () => {
    const h = await createTestHarness(registerEcho);
    try {
      expect(h.client).toBeDefined();
      expect(h.server).toBeDefined();
      expect(typeof h.client.callTool).toBe('function');
    } finally {
      await h.close();
    }
  });

  it('close is idempotent and does not throw on double-close', async () => {
    const h = await createTestHarness(registerEcho);
    await h.close();
    await expect(h.close()).resolves.toBeUndefined();
  });
});

describe('parseToolResult', () => {
  it('parses the JSON body from the first text content block', () => {
    const result: CallToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ a: 1 }) }],
    };
    expect(parseToolResult<{ a: number }>(result)).toEqual({ a: 1 });
  });

  it('throws a helpful error when the result has no content', () => {
    const result = { content: [] } as unknown as CallToolResult;
    expect(() => parseToolResult(result)).toThrow(/no text content/i);
  });

  it('throws a helpful error when the first block is not text', () => {
    const result = {
      content: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
    } as unknown as CallToolResult;
    expect(() => parseToolResult(result)).toThrow(/no text content/i);
  });

  it('surfaces the raw text when JSON parsing fails', () => {
    const result: CallToolResult = {
      content: [{ type: 'text', text: 'not json {' }],
    };
    expect(() => parseToolResult(result)).toThrow(/not json/i);
  });
});

describe('versionSyncTest', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function scaffold(version: string, files: Record<string, string>): { srcDir: string; pkgPath: string } {
    dir = mkdtempSync(join(tmpdir(), 'vst-'));
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ version }), 'utf8');
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const p = join(srcDir, name);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, content, 'utf8');
    }
    return { srcDir, pkgPath };
  }

  it('returns no mismatches when annotations match package.json', () => {
    const { srcDir, pkgPath } = scaffold('1.2.3', {
      'version.ts': `export const VERSION = '1.2.3'; // x-release-please-version\n`,
    });
    expect(versionSyncTest({ srcDir, pkgPath })).toEqual([]);
  });

  it('reports a mismatch when a version constant drifts', () => {
    const { srcDir, pkgPath } = scaffold('1.2.3', {
      'version.ts': `export const VERSION = '1.2.2'; // x-release-please-version\n`,
    });
    const mismatches = versionSyncTest({ srcDir, pkgPath });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('1.2.2');
    expect(mismatches[0]).toContain('1.2.3');
    expect(mismatches[0]).toContain('version.ts');
  });

  it('ignores marker lines that carry no version literal (docstrings)', () => {
    const { srcDir, pkgPath } = scaffold('1.2.3', {
      'doc.ts': `// add an x-release-please-version comment to that line\n`,
    });
    expect(versionSyncTest({ srcDir, pkgPath })).toEqual([]);
  });

  it('matches prerelease version strings', () => {
    const { srcDir, pkgPath } = scaffold('2.0.0-beta.1', {
      'version.ts': `const V = "2.0.0-beta.1"; // x-release-please-version\n`,
    });
    expect(versionSyncTest({ srcDir, pkgPath })).toEqual([]);
  });

  it('recurses into nested directories', () => {
    const { srcDir, pkgPath } = scaffold('3.3.3', {
      'a/b/c/version.ts': `const V = '3.3.0'; // x-release-please-version\n`,
    });
    const mismatches = versionSyncTest({ srcDir, pkgPath });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain(join('a', 'b', 'c', 'version.ts'));
  });
});

describe('makeBootstrapResult', () => {
  it('produces a fully-shaped BootstrapResult with sane defaults', () => {
    const r = makeBootstrapResult();
    expect(r).toEqual({
      cookies: {},
      localStorage: {},
      sessionStorage: {},
      capturedHeaders: {},
    });
  });

  it('merges overrides over the defaults', () => {
    const r = makeBootstrapResult({ cookies: { SID: 'abc' } });
    expect(r.cookies).toEqual({ SID: 'abc' });
    expect(r.localStorage).toEqual({});
    expect(r.capturedHeaders).toEqual({});
  });
});

describe('mockFetchproxyBootstrap', () => {
  it('returns a vi.fn spy that resolves a default BootstrapResult', async () => {
    const mock = mockFetchproxyBootstrap();
    const out = await mock.bootstrap();
    expect(out).toEqual(makeBootstrapResult());
    expect(mock.bootstrap).toHaveBeenCalledTimes(1);
  });

  it('accepts a default result override applied to every call', async () => {
    const mock = mockFetchproxyBootstrap({ cookies: { A: '1' } });
    const out = await mock.bootstrap();
    expect(out.cookies).toEqual({ A: '1' });
  });

  it('exposes a module factory suitable for vi.mock', async () => {
    const mock = mockFetchproxyBootstrap();
    const mod = mock.module();
    expect(typeof mod.bootstrap).toBe('function');
    await mod.bootstrap();
    expect(mock.bootstrap).toHaveBeenCalled();
  });

  it('reset() clears recorded calls', async () => {
    const mock = mockFetchproxyBootstrap();
    await mock.bootstrap();
    mock.reset();
    expect(mock.bootstrap).toHaveBeenCalledTimes(0);
  });
});

describe('setupClientMocks', () => {
  afterEach(() => vi.restoreAllMocks());

  it('spies on the named methods and returns the spies', async () => {
    const client = {
      request: async (_p: string) => ({ real: true }),
      requestPaginated: async () => [{ real: true }],
    };
    const mocks = setupClientMocks(client, {
      request: { ok: 1 },
      requestPaginated: [{ ok: 2 }],
    });
    await expect(client.request('/x')).resolves.toEqual({ ok: 1 });
    await expect(client.requestPaginated()).resolves.toEqual([{ ok: 2 }]);
    expect(mocks.request).toHaveBeenCalledWith('/x');
    expect(mocks.requestPaginated).toHaveBeenCalled();
  });

  it('spies without a stubbed return value (passthrough spy)', async () => {
    const client = { request: async (_p: string) => ({ real: true }) };
    const mocks = setupClientMocks(client, { request: undefined });
    const out = await client.request('/y');
    expect(out).toEqual({ real: true });
    expect(mocks.request).toHaveBeenCalledWith('/y');
  });
});
