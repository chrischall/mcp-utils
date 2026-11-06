import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpToolError } from '../errors/index.js';
import { createBlobStore } from './blob.js';
import { deliverFile, INLINE_DELIVERY_MAX_BYTES } from './deliver.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF\n');
const BASE = 'https://host.example/b/reg_0123456789abcdef01234567';

function fakeStore() {
  const puts: Array<{ url: string; type: string; bytes: Uint8Array }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    puts.push({ url, type: new Headers(init!.headers).get('content-type')!, bytes: new Uint8Array(init!.body as ArrayBuffer) });
    return new Response(null, { status: 201 });
  });
  vi.stubGlobal('fetch', fetchImpl);
  return { store: createBlobStore({ baseUrl: BASE, signingKey: 'a2V5' }), puts };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deliver-')); });
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe('deliverFile — inline', () => {
  it('returns a host-renderable image as ImageContent', async () => {
    const out = await deliverFile({ bytes: PNG, fileName: 'map.png', store: null });
    expect(out.via).toBe('image');
    expect(out.content).toEqual([{ type: 'image', data: Buffer.from(PNG).toString('base64'), mimeType: 'image/png' }]);
    expect(out).toMatchObject({ fileName: 'map.png', mimeType: 'image/png', sizeBytes: PNG.length });
  });

  it('returns anything else as an EmbeddedResource blob, mime stripped of parameters', async () => {
    const out = await deliverFile({ bytes: PDF, fileName: 'a b.pdf', mimeType: 'application/pdf; charset=UTF-8', store: null });
    expect(out.via).toBe('resource');
    expect(out.content).toEqual([{
      type: 'resource',
      resource: { uri: 'attachment:///a%20b.pdf', mimeType: 'application/pdf', blob: Buffer.from(PDF).toString('base64') },
    }]);
  });

  it('trusts the bytes over a wrong declared type for images', async () => {
    const out = await deliverFile({ bytes: PNG, fileName: 'x.bin', mimeType: 'application/octet-stream;charset=UTF-8', store: null });
    expect(out).toMatchObject({ via: 'image', mimeType: 'image/png' });
  });

  it('falls back to the extension when no type is given', async () => {
    expect((await deliverFile({ bytes: PDF, fileName: 'r.pdf', store: null })).mimeType).toBe('application/pdf');
  });

  it('keeps the default inline cap under the host result limit once base64-encoded', () => {
    // mcp-host swaps a child result over 14 MiB for a generic error.
    expect(Math.ceil(INLINE_DELIVERY_MAX_BYTES / 3) * 4).toBeLessThan(14 * 1024 * 1024);
  });
});

describe('deliverFile — link', () => {
  it('over the inline cap with a blob store: PUTs the bytes and returns a signed link', async () => {
    const { store, puts } = fakeStore();
    const out = await deliverFile({ bytes: PDF, fileName: 'Big Report.pdf', store, inlineMaxBytes: 4, keyPrefix: 'receipts', linkTtlMs: 5 * 60_000 });
    expect(out.via).toBe('link');
    expect(out.content).toEqual([]);
    expect(out.url).toMatch(new RegExp(`^${BASE}/receipts/[0-9a-f-]{36}/Big_Report\\.pdf\\?exp=\\d+&sig=`));
    expect(Date.parse(out.expiresAt!) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(out.note).toMatch(/too large to return inline/);
    expect(puts[0]).toMatchObject({ type: 'application/pdf' });
    expect(puts[0]!.bytes).toEqual(PDF);
  });

  it("prefer:'link' links even a small file", async () => {
    const { store } = fakeStore();
    expect((await deliverFile({ bytes: PNG, fileName: 'p.png', store, prefer: 'link' })).via).toBe('link');
  });

  it("prefer:'disk' on a hosted server links instead, and says why", async () => {
    const { store } = fakeStore();
    const out = await deliverFile({ bytes: PDF, fileName: 'r.pdf', store, prefer: 'disk', disk: { dir } });
    expect(out.via).toBe('link');
    expect(out.note).toMatch(/server's disk is not reachable/);
  });

  it('a key segment is reduced to the store alphabet and never empty or dotted', async () => {
    const { store } = fakeStore();
    expect((await deliverFile({ bytes: PDF, fileName: '..', store, prefer: 'link' })).url).toMatch(/\/file\?exp=/);
    expect((await deliverFile({ bytes: PDF, fileName: 'résumé #2.pdf', store, prefer: 'link' })).url).toMatch(/\/r_sum___2\.pdf\?exp=/);
  });
});

describe('deliverFile — disk (local installs)', () => {
  it("prefer:'disk' writes a fresh file and never overwrites", async () => {
    const a = await deliverFile({ bytes: PDF, fileName: 'r.pdf', store: null, prefer: 'disk', disk: { dir } });
    const b = await deliverFile({ bytes: PNG, fileName: 'r.pdf', store: null, prefer: 'disk', disk: { dir } });
    expect(a).toMatchObject({ via: 'disk', path: join(dir, 'r.pdf') });
    expect(b.path).toBe(join(dir, 'r-2.pdf'));
    expect(readFileSync(a.path!)).toEqual(Buffer.from(PDF));
  });

  it('over the inline cap with no blob store: falls back to disk', async () => {
    const out = await deliverFile({ bytes: PDF, fileName: 'r.pdf', store: null, inlineMaxBytes: 4, disk: { dir } });
    expect(out.via).toBe('disk');
    expect(out.note).toMatch(/too large to return inline/);
  });

  it('a name with no safe extension takes one from the type', async () => {
    const out = await deliverFile({ bytes: PDF, fileName: 'statement', mimeType: 'application/pdf', store: null, prefer: 'disk', disk: { dir } });
    expect(out.path).toBe(join(dir, 'statement.pdf'));
  });

  it('confines the directory to allowedRoots', async () => {
    await expect(deliverFile({ bytes: PDF, fileName: 'r.pdf', store: null, prefer: 'disk', disk: { dir: '/etc/x', allowedRoots: [dir] } }))
      .rejects.toThrow();
  });
});

describe('deliverFile — no route', () => {
  it('too large, no store, no disk: a too_large error naming the size, the cap and what would help', async () => {
    const err = await deliverFile({ bytes: PDF, fileName: 'r.pdf', store: null, inlineMaxBytes: 4 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
    expect((err as Error).message).toMatch(new RegExp(`r\\.pdf is ${PDF.length} bytes, over the 4-byte inline limit`));
  });

  it("prefer:'link' with neither store nor disk still inlines what fits, with a note", async () => {
    const out = await deliverFile({ bytes: PDF, fileName: 'r.pdf', store: null, prefer: 'link' });
    expect(out.via).toBe('resource');
    expect(out.note).toMatch(/no blob store/);
  });

  it("prefer:'disk' with no disk configured inlines what fits, with a note", async () => {
    const out = await deliverFile({ bytes: PDF, fileName: 'r.pdf', store: null, prefer: 'disk' });
    expect(out.via).toBe('resource');
    expect(out.note).toMatch(/no download directory/);
  });

  it('reads the blob store from the environment by default', async () => {
    vi.stubEnv('MCP_BLOB_BASE_URL', BASE);
    vi.stubEnv('MCP_BLOB_SIGNING_KEY', 'a2V5');
    fakeStore();
    try {
      expect((await deliverFile({ bytes: PDF, fileName: 'r.pdf', prefer: 'link' })).via).toBe('link');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('deliverFile — preferred route with nothing that fits', () => {
  it.each(['link', 'disk'] as const)("prefer:'%s', too large, no store, no disk: too_large", async (prefer) => {
    const err = await deliverFile({ bytes: PDF, fileName: 'r.pdf', store: null, inlineMaxBytes: 4, prefer }).catch((e: unknown) => e);
    expect((err as McpToolError).kind).toBe('too_large');
  });

  it("prefer:'link' with no store but a disk saves to disk, with a note", async () => {
    const out = await deliverFile({ bytes: PDF, fileName: 'r.pdf', store: null, prefer: 'link', disk: { dir } });
    expect(out.via).toBe('disk');
    expect(out.note).toMatch(/no blob store/);
  });
});

describe('deliverFile — disk mode', () => {
  it('creates the file with the given mode (no chmod window)', async () => {
    const { statSync } = await import('node:fs');
    const out = await deliverFile({ bytes: PDF, fileName: 'r.pdf', store: null, prefer: 'disk', disk: { dir, mode: 0o600 } });
    expect(statSync(out.path!).mode & 0o777).toBe(0o600);
  });
});

describe('deliverFile — non-image files on a hosted server', () => {
  // claude.ai renders four image types inline and rejects every other
  // EmbeddedResource outright, so on a server with a blob store a small PDF
  // must go out as a link, not a resource the client throws away.
  it("'auto' links a small non-image file when a blob store exists", async () => {
    const { store, puts } = fakeStore();
    const out = await deliverFile({ bytes: PDF, fileName: 'r.pdf', store });
    expect(out.via).toBe('link');
    expect(out.note).toMatch(/only render images inline/);
    expect(puts).toHaveLength(1);
  });

  it("'auto' still inlines a small image when a blob store exists", async () => {
    const { store, puts } = fakeStore();
    expect((await deliverFile({ bytes: PNG, fileName: 'p.png', store })).via).toBe('image');
    expect(puts).toHaveLength(0);
  });

  it("prefer:'inline' keeps the resource for a caller that wants the bytes", async () => {
    const { store } = fakeStore();
    expect((await deliverFile({ bytes: PDF, fileName: 'r.pdf', store, prefer: 'inline' })).via).toBe('resource');
  });
});
