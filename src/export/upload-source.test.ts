import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpToolError } from '../errors/index.js';
import { createBlobStore } from './blob.js';
import { mintUploadSlot } from './upload.js';
import { resolveUploadSource } from './upload-source.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF\n');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const BASE = 'https://host.example/b/reg_0123456789abcdef01234567';
const MiB = 1024 * 1024;

/** A blob store whose objects live in a map, behind a stubbed fetch. */
function fakeStore(opts: { deleteStatus?: number } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const key = decodeURIComponent(new URL(input).pathname.replace('/b/reg_0123456789abcdef01234567/', ''));
    const method = init?.method ?? 'GET';
    calls.push(method);
    if (method === 'DELETE') {
      if (opts.deleteStatus && opts.deleteStatus >= 400) return new Response('', { status: opts.deleteStatus });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const o = objects.get(key);
    return o ? new Response(o.bytes.slice(), { headers: { 'content-type': o.type } }) : new Response('', { status: 404 });
  }));
  const store = createBlobStore({ baseUrl: BASE, signingKey: 'a2V5' });
  const put = (name: string, bytes: Uint8Array, type?: string) => {
    const slot = mintUploadSlot(store, { filename: name, ...(type ? { mimeType: type } : {}) });
    objects.set(slot.blobKey, { bytes, type: slot.mimeType });
    return slot.blobKey;
  };
  return { store, put, objects, calls };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'upsrc-')); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const PATHS = { mimeByExt: { jpg: 'image/jpeg', pdf: 'application/pdf' }, allowedRoots: [] as string[] };

describe('resolveUploadSource — exactly one source', () => {
  it.each([[{}], [{ inline: { filename: 'a.jpg', contentBase64: b64(JPEG) }, blobKey: 'x' }]])('refuses %j', async (input) => {
    await expect(resolveUploadSource(input, { maxBytes: MiB, store: null, hosted: false }))
      .rejects.toThrow(/exactly one of path, inline or blobKey/);
  });

  it('names the caller’s own parameter spellings', async () => {
    await expect(resolveUploadSource({}, { maxBytes: MiB, store: null, hosted: false, names: { path: 'file_path', blobKey: 'blob_key' } }))
      .rejects.toThrow(/exactly one of file_path, inline or blob_key/);
  });
});

describe('resolveUploadSource — inline', () => {
  it('decodes strictly and reports name, type, size and sha256', async () => {
    const src = await resolveUploadSource({ inline: { filename: ' photo.jpg ', contentBase64: b64(JPEG) } }, { maxBytes: MiB, store: null, hosted: false });
    expect(src).toMatchObject({ origin: 'inline', fileName: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG.length, sha256: sha(JPEG) });
    expect(src.bytes).toEqual(JPEG);
    expect(await src.release()).toEqual({ deleted: null });
  });

  it('refuses bad base64 and an over-size file, naming the limit', async () => {
    await expect(resolveUploadSource({ inline: { filename: 'a.jpg', contentBase64: 'abc' } }, { maxBytes: MiB, store: null, hosted: false }))
      .rejects.toThrow(/not valid base64/);
    await expect(resolveUploadSource({ inline: { filename: 'a.jpg', contentBase64: b64(JPEG) } }, { maxBytes: 4, store: null, hosted: false }))
      .rejects.toThrow(/limit is 0 MiB \(4 bytes\)/);
  });

  it('enforces an allowlist, and the bytes must match the claimed type', async () => {
    const opts = { maxBytes: MiB, store: null, hosted: false, allowedMimeTypes: ['image/jpeg', 'application/pdf'] };
    await expect(resolveUploadSource({ inline: { filename: 'a.png', contentBase64: b64(JPEG) } }, opts)).rejects.toThrow(/image\/png is not accepted/);
    await expect(resolveUploadSource({ inline: { filename: 'a.pdf', contentBase64: b64(JPEG) } }, opts)).rejects.toThrow(/do not look like application\/pdf/);
    expect((await resolveUploadSource({ inline: { filename: 'a.pdf', contentBase64: b64(PDF) } }, opts)).mimeType).toBe('application/pdf');
  });
});

describe('resolveUploadSource — blob key', () => {
  it('reads the uploaded object without deleting it; release() deletes', async () => {
    const f = fakeStore();
    const key = f.put('Scan 1.pdf', PDF);
    const src = await resolveUploadSource({ blobKey: key }, { maxBytes: MiB, store: f.store, hosted: true });
    expect(src).toMatchObject({ origin: 'blob', blobKey: key, fileName: 'Scan 1.pdf', mimeType: 'application/pdf', sha256: sha(PDF) });
    expect(f.objects.has(key)).toBe(true);
    expect(await src.release()).toEqual({ deleted: true });
    expect(f.objects.has(key)).toBe(false);
  });

  it('release() reports a failed delete instead of throwing, and treats 404 as deleted', async () => {
    const f = fakeStore({ deleteStatus: 500 });
    const src = await resolveUploadSource({ blobKey: f.put('a.pdf', PDF) }, { maxBytes: MiB, store: f.store, hosted: true });
    const r = await src.release();
    expect(r.deleted).toBe(false);
    expect((r as { error: string }).error).toMatch(/HTTP 500/);
    const g = fakeStore({ deleteStatus: 404 });
    const src2 = await resolveUploadSource({ blobKey: g.put('a.pdf', PDF) }, { maxBytes: MiB, store: g.store, hosted: true });
    expect(await src2.release()).toEqual({ deleted: true });
  });

  it('refuses a foreign key, a missing object, an over-size object, and a missing store', async () => {
    const f = fakeStore();
    await expect(resolveUploadSource({ blobKey: 'exp/x/y.zip' }, { maxBytes: MiB, store: f.store, hosted: true })).rejects.toThrow(/not an upload key/);
    const gone = mintUploadSlot(f.store, { filename: 'a.pdf' }).blobKey;
    await expect(resolveUploadSource({ blobKey: gone }, { maxBytes: MiB, store: f.store, hosted: true })).rejects.toThrow(/not found/);
    await expect(resolveUploadSource({ blobKey: f.put('a.pdf', PDF) }, { maxBytes: 4, store: f.store, hosted: true })).rejects.toThrow();
    await expect(resolveUploadSource({ blobKey: 'uploads/x/y' }, { maxBytes: MiB, store: null, hosted: true, names: { slotTool: 'x_upload_slots' } }))
      .rejects.toThrow(/no blob store/);
  });

  it('applies the allowlist and magic check to blobs too', async () => {
    const f = fakeStore();
    const key = f.put('a.pdf', JPEG);
    await expect(resolveUploadSource({ blobKey: key }, { maxBytes: MiB, store: f.store, hosted: true, allowedMimeTypes: ['application/pdf'] }))
      .rejects.toThrow(/do not look like application\/pdf/);
  });

  it('honours a custom key prefix', async () => {
    const f = fakeStore();
    const slot = mintUploadSlot(f.store, { filename: 'a.pdf' }, { prefix: 'receipts' });
    f.objects.set(slot.blobKey, { bytes: PDF, type: 'application/pdf' });
    expect((await resolveUploadSource({ blobKey: slot.blobKey }, { maxBytes: MiB, store: f.store, hosted: true, keyPrefix: 'receipts' })).fileName).toBe('a.pdf');
  });
});

describe('resolveUploadSource — path', () => {
  it('vets a local file inside the roots (no-op release)', async () => {
    writeFileSync(join(dir, 'a.jpg'), JPEG);
    const src = await resolveUploadSource({ path: 'a.jpg' }, { maxBytes: MiB, store: null, hosted: false, path: { ...PATHS, allowedRoots: [dir], baseDir: dir } });
    expect(src).toMatchObject({ origin: 'path', fileName: 'a.jpg', mimeType: 'image/jpeg', sha256: sha(JPEG) });
    expect(await src.release()).toEqual({ deleted: null });
  });

  it('on a hosted server refuses a path with an explanation naming the alternatives', async () => {
    const { store } = fakeStore();
    const err = await resolveUploadSource({ path: 'a.jpg' }, {
      maxBytes: MiB, store, hosted: true, path: { ...PATHS, allowedRoots: [dir] }, names: { slotTool: 'x_upload_slots' },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/remote and can't read files on your machine/);
    expect((err as Error).message).toMatch(/x_upload_slots/);
    expect((err as Error).message).toMatch(/inline/);
  });

  it('with no blob store, the hosted refusal points only at inline', async () => {
    const err = await resolveUploadSource({ path: 'a.jpg' }, { maxBytes: MiB, store: null, hosted: true, path: { ...PATHS, allowedRoots: [dir] } })
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Pass the bytes with inline/);
    expect((err as Error).message).not.toMatch(/upload slot/);
  });

  it('refuses a path when the tool did not opt into paths', async () => {
    await expect(resolveUploadSource({ path: 'a.jpg' }, { maxBytes: MiB, store: null, hosted: false })).rejects.toThrow(/does not accept a path/);
  });

  it('detects hosting from the environment by default', async () => {
    vi.stubEnv('MCP_DATA_DIR', dir);
    await expect(resolveUploadSource({ path: 'a.jpg' }, { maxBytes: MiB, store: null, path: { ...PATHS, allowedRoots: [dir] } }))
      .rejects.toThrow(/remote/);
  });
});

describe('resolveUploadSource — defaults', () => {
  it('reads the blob store from the environment by default', async () => {
    const f = fakeStore();
    const key = f.put('a.pdf', PDF);
    vi.stubEnv('MCP_BLOB_BASE_URL', BASE);
    vi.stubEnv('MCP_BLOB_SIGNING_KEY', 'a2V5');
    expect((await resolveUploadSource({ blobKey: key }, { maxBytes: MiB })).origin).toBe('blob');
  });

  it('without a slot tool name, the hosted refusal describes the route generically', async () => {
    const { store } = fakeStore();
    await expect(resolveUploadSource({ path: 'a.jpg' }, { maxBytes: MiB, store, hosted: true }))
      .rejects.toThrow(/upload it to an upload slot and pass blobKey/);
  });
});
