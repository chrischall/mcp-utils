import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { open } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpToolError } from '../errors/index.js';
import { UploadRefusedError, vetUploadFile, type VetUploadOptions } from './index.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(8)]);

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', mov: 'video/quicktime' };

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-utils-upload-'));
  outside = mkdtempSync(join(tmpdir(), 'mcp-utils-upload-outside-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function put(dir: string, name: string, bytes: Buffer | string): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

function opts(over: Partial<VetUploadOptions> = {}): VetUploadOptions {
  return { mimeByExt: MIME, maxBytes: 1024, allowedRoots: [root], ...over };
}

async function refused(p: Promise<unknown>): Promise<UploadRefusedError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UploadRefusedError);
  return err as UploadRefusedError;
}

describe('vetUploadFile — accepts', () => {
  it('a real image of an allowed type inside the root', async () => {
    const p = put(root, 'photo.jpg', JPEG);
    const v = await vetUploadFile(p, opts());
    expect(v).toMatchObject({ ext: 'jpg', mime: 'image/jpeg', size: JPEG.length });
    expect(v.path).toBe(realpathSync(p));
    expect(v.requested).toBe(p);
    expect(v.allowedRoots).toEqual([root]);
    expect(v.bytes).toBeUndefined();
  });

  it('an upper-case extension', async () => {
    const p = put(root, 'PHOTO.PNG', PNG);
    expect((await vetUploadFile(p, opts())).mime).toBe('image/png');
  });

  it('an ISO-BMFF video', async () => {
    const p = put(root, 'clip.mov', MOV);
    expect((await vetUploadFile(p, opts())).mime).toBe('video/quicktime');
  });

  it('a relative path, resolved against baseDir', async () => {
    mkdirSync(join(root, 'sub'));
    put(join(root, 'sub'), 'a.jpg', JPEG);
    const v = await vetUploadFile('sub/a.jpg', opts({ baseDir: root }));
    expect(v.path).toBe(realpathSync(join(root, 'sub', 'a.jpg')));
  });

  it('expands a leading ~ (and confines the result)', async () => {
    const err = await refused(vetUploadFile('~/definitely-not-here.jpg', opts()));
    expect(err.reason).toBe('outside-roots');
    expect(err.message).toContain(homedir());
  });

  it('returns the whole file from the vetted descriptor when readAll is set', async () => {
    const body = Buffer.concat([JPEG, Buffer.from('rest-of-image')]);
    const p = put(root, 'photo.jpg', body);
    const v = await vetUploadFile(p, opts({ readAll: true }));
    expect(Buffer.from(v.bytes!)).toEqual(body);
  });

  it('any path when explicitly unconfined', async () => {
    const p = put(outside, 'photo.jpg', JPEG);
    const v = await vetUploadFile(p, opts({ allowedRoots: 'unconfined' }));
    expect(v.mime).toBe('image/jpeg');
    expect(v.allowedRoots).toBeUndefined();
  });

  it('a file reached through a symlinked ROOT directory (macOS /var → /private/var)', async () => {
    const linkedRoot = join(outside, 'root-link');
    symlinkSync(root, linkedRoot);
    const p = put(root, 'photo.jpg', JPEG);
    const v = await vetUploadFile(join(linkedRoot, 'photo.jpg'), opts({ allowedRoots: [linkedRoot] }));
    expect(v.path).toBe(realpathSync(p));
  });
});

describe('vetUploadFile — refuses (fail closed)', () => {
  it('a path outside allowedRoots', async () => {
    const p = put(outside, 'photo.jpg', JPEG);
    const err = await refused(vetUploadFile(p, opts()));
    expect(err.reason).toBe('outside-roots');
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.message).toMatch(/^Refusing to upload /);
  });

  it('checks confinement first — an outside path with a bad extension reports outside-roots', async () => {
    const p = put(outside, 'id_ed25519', 'secret');
    expect((await refused(vetUploadFile(p, opts()))).reason).toBe('outside-roots');
  });

  it('everything, when allowedRoots is empty', async () => {
    const p = put(root, 'photo.jpg', JPEG);
    expect((await refused(vetUploadFile(p, opts({ allowedRoots: [] })))).reason).toBe('outside-roots');
  });

  it('a path that escapes the root through a symlinked directory', async () => {
    put(outside, 'photo.jpg', JPEG);
    symlinkSync(outside, join(root, 'sneaky'));
    const err = await refused(vetUploadFile(join(root, 'sneaky', 'photo.jpg'), opts()));
    expect(err.reason).toBe('outside-roots');
  });

  it('a ../ traversal out of baseDir', async () => {
    put(outside, 'photo.jpg', JPEG);
    const rel = join('..', outside.split('/').pop()!, 'photo.jpg');
    expect((await refused(vetUploadFile(rel, opts({ baseDir: root })))).reason).toBe('outside-roots');
  });

  it('an extension not on the allowlist', async () => {
    const p = put(root, 'notes.txt', 'hello');
    const err = await refused(vetUploadFile(p, opts()));
    expect(err.reason).toBe('extension');
    expect(err.message).toMatch(/allowed: jpg, jpeg, png, mov/);
  });

  it('an extensionless path (what key and credential files look like)', async () => {
    const p = put(root, 'id_ed25519', JPEG);
    expect((await refused(vetUploadFile(p, opts()))).reason).toBe('extension');
  });

  it('a final-component symlink, even to a valid image inside the root', async () => {
    const real = put(root, 'real.jpg', JPEG);
    symlinkSync(real, join(root, 'link.jpg'));
    const err = await refused(vetUploadFile(join(root, 'link.jpg'), opts()));
    expect(err.reason).toBe('symlink');
  });

  it('a final-component symlink when unconfined', async () => {
    const real = put(outside, 'real.jpg', JPEG);
    symlinkSync(real, join(root, 'link.jpg'));
    const err = await refused(vetUploadFile(join(root, 'link.jpg'), opts({ allowedRoots: 'unconfined' })));
    expect(err.reason).toBe('symlink');
  });

  it('a directory', async () => {
    mkdirSync(join(root, 'album.jpg'));
    expect((await refused(vetUploadFile(join(root, 'album.jpg'), opts()))).reason).toBe('not-file');
  });

  it('a named pipe (FIFO) — refused without hanging on the open', async () => {
    const fifo = join(root, 'pipe.jpg');
    execFileSync('mkfifo', [fifo]);
    expect((await refused(vetUploadFile(fifo, opts()))).reason).toBe('not-file');
  });

  it('a file over maxBytes', async () => {
    const p = put(root, 'big.jpg', Buffer.concat([JPEG, Buffer.alloc(2000)]));
    const err = await refused(vetUploadFile(p, opts()));
    expect(err.reason).toBe('too-large');
    expect(err.message).toMatch(/1 KiB/);
  });

  it('accepts a file exactly at maxBytes', async () => {
    const p = put(root, 'edge.jpg', Buffer.concat([JPEG, Buffer.alloc(1024 - JPEG.length)]));
    expect((await vetUploadFile(p, opts())).size).toBe(1024);
  });

  it('a renamed non-image (magic mismatch)', async () => {
    const p = put(root, 'credentials.png', '[default]\naws_secret_access_key = abc\n');
    const err = await refused(vetUploadFile(p, opts()));
    expect(err.reason).toBe('signature');
    expect(err.message).toMatch(/does not look like a \.png/);
  });

  it('a JPEG renamed .png (right family, wrong type)', async () => {
    const p = put(root, 'photo.png', JPEG);
    expect((await refused(vetUploadFile(p, opts()))).reason).toBe('signature');
  });

  it('an allowed extension whose MIME it cannot sniff (no silent pass)', async () => {
    const p = put(root, 'doc.txt', 'hello');
    const err = await refused(vetUploadFile(p, opts({ mimeByExt: { txt: 'text/plain' } })));
    expect(err.reason).toBe('signature');
  });

  it('a missing file, without leaking the fs error', async () => {
    const err = await refused(vetUploadFile(join(root, 'gone.jpg'), opts()));
    expect(err.reason).toBe('unreadable');
    expect(err.message).not.toMatch(/ENOENT/);
  });

  it('a hidden file when denyHiddenSegments is set', async () => {
    const p = put(root, '.secret.jpg', JPEG);
    expect((await refused(vetUploadFile(p, opts({ denyHiddenSegments: true })))).reason).toBe('hidden');
  });

  it('a file under a hidden directory when denyHiddenSegments is set', async () => {
    mkdirSync(join(root, '.ssh'));
    const p = put(join(root, '.ssh'), 'key.jpg', JPEG);
    expect((await refused(vetUploadFile(p, opts({ denyHiddenSegments: true })))).reason).toBe('hidden');
  });

  it('only judges hidden segments BELOW the root (a root under ~/.config is fine)', async () => {
    const hiddenRoot = join(root, '.cache', 'uploads');
    mkdirSync(hiddenRoot, { recursive: true });
    const p = put(hiddenRoot, 'ok.jpg', JPEG);
    const v = await vetUploadFile(p, opts({ allowedRoots: [hiddenRoot], denyHiddenSegments: true }));
    expect(v.mime).toBe('image/jpeg');
  });

  it('allows hidden segments when denyHiddenSegments is not set', async () => {
    const p = put(root, '.ok.jpg', JPEG);
    expect((await vetUploadFile(p, opts())).ext).toBe('jpg');
  });
});

describe('vetUploadFile — readAll buffer sizing', () => {
  /** Append `extra` to `path` right after the guard's fstat — a file that grows mid-vet. */
  async function growAfterFstat(path: string, extra: Buffer): Promise<void> {
    const probe = await open(put(root, 'probe.bin', ''), 'r');
    const proto = Object.getPrototypeOf(probe) as { stat: (...a: unknown[]) => Promise<unknown> };
    await probe.close();
    const real = proto.stat;
    vi.spyOn(proto, 'stat').mockImplementation(async function (this: unknown, ...a: unknown[]) {
      const st = await real.apply(this, a);
      appendFileSync(path, extra);
      return st;
    });
  }

  it('sizes the buffer from the fstat size, not the cap (no 256 MiB zero-fill for a tiny file)', async () => {
    const p = put(root, 'tiny.jpg', JPEG);
    const alloc = vi.spyOn(Buffer, 'alloc');
    const v = await vetUploadFile(p, opts({ readAll: true, maxBytes: 256 * 1024 * 1024 }));
    expect(Buffer.from(v.bytes!)).toEqual(JPEG);
    const largest = Math.max(0, ...alloc.mock.calls.map((c) => c[0]));
    expect(largest).toBeLessThan(64 * 1024);
  });

  it('still reads a file that grew past its fstat size but stays under the cap', async () => {
    const body = Buffer.concat([JPEG, Buffer.alloc(600, 7)]);
    const p = put(root, 'grew.jpg', JPEG);
    await growAfterFstat(p, Buffer.alloc(600, 7));
    const v = await vetUploadFile(p, opts({ readAll: true }));
    expect(Buffer.from(v.bytes!)).toEqual(body);
    expect(v.size).toBe(body.length);
  });

  it('still refuses a file that grew past its fstat size AND past the cap', async () => {
    const p = put(root, 'grew-big.jpg', JPEG);
    await growAfterFstat(p, Buffer.alloc(5000, 7));
    const alloc = vi.spyOn(Buffer, 'alloc');
    expect((await refused(vetUploadFile(p, opts({ readAll: true })))).reason).toBe('too-large');
    // Widening never allocates past the cap + 1.
    expect(Math.max(0, ...alloc.mock.calls.map((c) => c[0]))).toBeLessThanOrEqual(1024 + 1);
  });
});
