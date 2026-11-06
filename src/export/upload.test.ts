import { describe, expect, it } from 'vitest';
import { createBlobStore } from './blob.js';
import {
  checkUploadSize,
  decodeBase64Strict,
  inlineFileSchema,
  MAX_UPLOAD_FILES,
  mimeFromFileName,
  mintUploadSlot,
  resolveUploadMime,
  sanitizeUploadFilename,
  uploadFileNameFromKey,
  UPLOAD_KEY_PREFIX,
  UPLOAD_SLOT_DEFAULT_TTL_MS,
  uploadSlotRequestSchema,
} from './upload.js';

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const STORE = createBlobStore({ baseUrl: 'https://host.example/b/reg_0123456789abcdef01234567', signingKey: 'a2V5' });
const MiB = 1024 * 1024;

describe('sanitizeUploadFilename', () => {
  it('keeps an ordinary filename, spaces and unicode included, trimmed', () => {
    expect(sanitizeUploadFilename('  Think Sheet 11-3.jpg ')).toBe('Think Sheet 11-3.jpg');
    expect(sanitizeUploadFilename('reçu.pdf')).toBe('reçu.pdf');
  });

  it.each([
    ['', /empty/],
    ['   ', /empty/],
    ['photos/a.jpg', /bare filename/],
    ['..\\a.jpg', /bare filename/],
    ['.env', /dot/],
    ['..', /dot/],
    ['a\u0000.jpg', /control/],
    ['a\n.jpg', /control/],
    ['x'.repeat(201), /200/],
  ])('refuses %j', (name, why) => {
    expect(() => sanitizeUploadFilename(name)).toThrow(why);
  });
});

describe('mimeFromFileName / resolveUploadMime', () => {
  it.each([
    ['a.jpg', 'image/jpeg'],
    ['a.JPEG', 'image/jpeg'],
    ['a.png', 'image/png'],
    ['a.heic', 'image/heic'],
    ['a.webp', 'image/webp'],
    ['a.pdf', 'application/pdf'],
    ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['a.mp4', 'video/mp4'],
    ['noext', 'application/octet-stream'],
    ['a.unknownext', 'application/octet-stream'],
  ])('%s → %s', (name, mime) => {
    expect(mimeFromFileName(name)).toBe(mime);
    expect(resolveUploadMime(name)).toBe(mime);
  });

  it('prefers an explicit mimeType, normalised to a bare lowercase media type', () => {
    expect(resolveUploadMime('scan', 'Image/PNG; charset=UTF-8')).toBe('image/png');
  });

  it('refuses a mimeType that is not type/subtype', () => {
    expect(() => resolveUploadMime('a.jpg', 'jpeg')).toThrow(/mimeType/);
    expect(() => resolveUploadMime('a.jpg', 'image/jp eg')).toThrow(/mimeType/);
    expect(() => resolveUploadMime('a.jpg', '')).toThrow(/mimeType/);
  });
});

describe('checkUploadSize', () => {
  it('refuses empty and over-cap sizes, naming the limit in MiB and bytes', () => {
    expect(() => checkUploadSize('a.jpg', 0, MiB)).toThrow(/a\.jpg is empty/);
    expect(() => checkUploadSize('a.jpg', MiB + 1, MiB)).toThrow(/limit is 1 MiB \(1048576 bytes\)/);
    expect(() => checkUploadSize('a.jpg', MiB, MiB)).not.toThrow();
  });

  it('floors a fractional MiB limit rather than rounding it up', () => {
    expect(() => checkUploadSize('a', MiB * 2, 1.5 * MiB)).toThrow(/limit is 1 MiB \(1572864 bytes\)/);
  });
});

describe('decodeBase64Strict', () => {
  const opts = { fileName: 'photo.jpg', maxBytes: 25 * MiB };

  it('decodes standard base64, tolerating line wrapping and a data: URL prefix', () => {
    expect(decodeBase64Strict(b64(JPEG), opts)).toEqual(new Uint8Array(JPEG));
    const text = 'hello world, this is long enough to wrap';
    const wrapped = b64(text).replace(/(.{8})/g, '$1\n');
    expect(Buffer.from(decodeBase64Strict(wrapped, opts)).toString()).toBe(text);
    expect(decodeBase64Strict(`data:image/jpeg;base64,${b64(JPEG)}`, opts)).toEqual(new Uint8Array(JPEG));
  });

  it.each([
    ['not base64!'],
    ['abc'], // truncated
    ['ab=c'],
    ['-_-_'], // base64url alphabet
    ['QR=='], // non-canonical padding bits
  ])('refuses %j, naming the file', (content) => {
    expect(() => decodeBase64Strict(content, opts)).toThrow(/photo\.jpg: contentBase64 is not valid base64/);
  });

  it('refuses an empty file', () => {
    expect(() => decodeBase64Strict('', opts)).toThrow(/empty/);
    expect(() => decodeBase64Strict('data:image/png;base64,', opts)).toThrow(/empty/);
  });

  it('refuses an over-size payload from its encoded length, before decoding', () => {
    const tooBig = 'A'.repeat(Math.ceil((MiB + 3) / 3) * 4);
    expect(() => decodeBase64Strict(tooBig, { fileName: 'big.bin', maxBytes: MiB })).toThrow(/limit is 1 MiB/);
  });

  it('accepts exactly the limit, padding accounted for', () => {
    expect(decodeBase64Strict(b64(Buffer.alloc(5, 1)), { fileName: 'f', maxBytes: 5 }).length).toBe(5);
    expect(() => decodeBase64Strict(b64(Buffer.alloc(6, 1)), { fileName: 'f', maxBytes: 5 })).toThrow(/too large/);
  });
});

describe('schemas', () => {
  it('inlineFileSchema takes filename + contentBase64 + optional mimeType', () => {
    expect(inlineFileSchema.parse({ filename: 'a.jpg', contentBase64: 'QQ==' })).toEqual({ filename: 'a.jpg', contentBase64: 'QQ==' });
    expect(inlineFileSchema.safeParse({ filename: 'a.jpg' }).success).toBe(false);
  });

  it('uploadSlotRequestSchema takes filename + optional mimeType', () => {
    expect(uploadSlotRequestSchema.parse({ filename: 'a.jpg', mimeType: 'image/jpeg' })).toEqual({ filename: 'a.jpg', mimeType: 'image/jpeg' });
  });

  it('exports the fleet per-call file cap', () => {
    expect(MAX_UPLOAD_FILES).toBe(10);
  });
});

describe('mintUploadSlot / uploadFileNameFromKey', () => {
  it('mints a PUT slot whose key round-trips to the original filename', () => {
    const now = 1_767_225_600_000;
    const slot = mintUploadSlot(STORE, { filename: 'Think Sheet 11-3.jpg' }, { now });
    expect(slot).toMatchObject({ filename: 'Think Sheet 11-3.jpg', mimeType: 'image/jpeg', method: 'PUT' });
    expect(slot.blobKey).toMatch(/^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+$/);
    expect(slot.uploadUrl.startsWith('https://host.example/b/reg_0123456789abcdef01234567/uploads/')).toBe(true);
    expect(slot.expiresAtMs).toBe(now + UPLOAD_SLOT_DEFAULT_TTL_MS);
    expect(slot.expiresAt).toBe(new Date(now + UPLOAD_SLOT_DEFAULT_TTL_MS).toISOString());
    expect(uploadFileNameFromKey(slot.blobKey)).toBe('Think Sheet 11-3.jpg');
    // The curl line must send the SAME content type the URL was signed for.
    expect(slot.curl).toContain("-H 'Content-Type: image/jpeg'");
    expect(slot.curl).toContain("--data-binary @'<path to Think Sheet 11-3.jpg>'");
    expect(slot.curl).toContain(slot.uploadUrl);
  });

  it('shell-quotes a filename containing a single quote in the curl placeholder', () => {
    expect(mintUploadSlot(STORE, { filename: "Finn's sheet.jpg" }).curl).toContain(`@'<path to Finn'\\''s sheet.jpg>'`);
  });

  it('honours a custom prefix and TTL', () => {
    const slot = mintUploadSlot(STORE, { filename: 'a.png' }, { prefix: 'refs', ttlMs: 60_000, now: 0 });
    expect(slot.blobKey.startsWith('refs/')).toBe(true);
    expect(slot.expiresAtMs).toBe(60_000);
    expect(uploadFileNameFromKey(slot.blobKey, { prefix: 'refs' })).toBe('a.png');
    expect(() => uploadFileNameFromKey(slot.blobKey)).toThrow(/not an upload key/);
  });

  it('mints a fresh key per slot, even for the same filename', () => {
    expect(mintUploadSlot(STORE, { filename: 'a.jpg' }).blobKey).not.toBe(mintUploadSlot(STORE, { filename: 'a.jpg' }).blobKey);
  });

  it('validates the filename and mime before minting', () => {
    expect(() => mintUploadSlot(STORE, { filename: '../a.jpg' })).toThrow(/bare filename/);
    expect(() => mintUploadSlot(STORE, { filename: 'a.jpg', mimeType: 'nope' })).toThrow(/mimeType/);
  });

  it('refuses a prefix that is not one safe key segment', () => {
    expect(() => mintUploadSlot(STORE, { filename: 'a.jpg' }, { prefix: 'a/b' })).toThrow(/prefix/);
    expect(() => uploadFileNameFromKey('x', { prefix: '' })).toThrow(/prefix/);
  });

  it.each([
    'exp/123/x.zip',
    'calendar/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/x.ics',
    `${UPLOAD_KEY_PREFIX}/not-a-uuid/YS5qcGc`,
    `${UPLOAD_KEY_PREFIX}/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/YS5qcGc/extra`,
    `${UPLOAD_KEY_PREFIX}/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/`,
  ])('refuses a key it did not mint: %s', (key) => {
    expect(() => uploadFileNameFromKey(key)).toThrow(/not an upload key/);
  });

  it('refuses a well-formed key whose encoded name is not a safe filename', () => {
    const evil = Buffer.from('../../etc/passwd').toString('base64url');
    expect(() => uploadFileNameFromKey(`uploads/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/${evil}`)).toThrow(/bare filename/);
  });
});
