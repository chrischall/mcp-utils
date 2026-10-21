import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpToolError } from '../errors/index.js';
import {
  EXPORT_BLOB_MAX_BYTES,
  EXPORT_CURSOR_MAX_LENGTH,
  EXPORT_MARKER,
  decodeExportCursor,
  encodeExportCursor,
  exportAllowedRoots,
  exportPartName,
  jsonlLine,
  openExportSink,
  sanitizeExportFileName,
} from './sink.js';

const BASE = 'https://mcp.example.com/b/reg-1234';
const KEY = 'test-signing-key-0123456789';
const BLOB_ENV = { MCP_BLOB_BASE_URL: BASE, MCP_BLOB_SIGNING_KEY: KEY };
const NOW = Date.UTC(2026, 9, 20, 9, 8, 7); // 2026-10-20T09:08:07Z

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'export-home-')));
  vi.stubEnv('HOME', home);
  for (const d of ['Downloads', 'Documents', 'Desktop']) mkdirSync(join(home, d));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const base = { name: 'office-outlook-mcp', envVar: 'OUTLOOK_OUTPUT_DIR', baseName: 'outlook-mail', now: NOW };

/** Minimal independent unzip: central directory → inflate. */
function unzip(zip: Uint8Array): Map<string, string> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    const raw = zip.subarray(start, start + csize);
    out.set(name, new TextDecoder().decode(method === 8 ? inflateRawSync(raw) : raw));
    p += 46 + nameLen;
  }
  return out;
}

describe('openExportSink — disk mode', () => {
  it('defaults to a fresh timestamped dir under ~/Downloads/<name> and returns absolute paths', async () => {
    const sink = await openExportSink({ ...base, env: {} });
    expect(sink.mode).toBe('disk');
    expect(sink.exportId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(sink.part).toBe(1);
    const dir = join(home, 'Downloads', 'office-outlook-mcp', 'outlook-mail-20261020-090807');
    expect(sink.dir).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const rec = await sink.addFile('part-0001.jsonl', jsonlLine({ a: 1 }));
    expect(rec).toEqual({ name: 'part-0001.jsonl', path: join(dir, 'part-0001.jsonl'), bytes: 8 });
    await sink.addFile('attachments/ab12/photo.png', new Uint8Array([1, 2, 3]), 'image/png');

    const loc = await sink.finish();
    expect(loc).toMatchObject({ mode: 'disk', location: dir, dir, exportId: sink.exportId, part: 1, bytes: 11 });
    expect(loc.files).toEqual([
      { name: 'part-0001.jsonl', path: join(dir, 'part-0001.jsonl'), bytes: 8 },
      { name: 'attachments/ab12/photo.png', path: join(dir, 'attachments', 'ab12', 'photo.png'), bytes: 3 },
    ]);
    expect(readFileSync(join(dir, 'part-0001.jsonl'), 'utf8')).toBe('{"a":1}\n');
    expect(statSync(join(dir, 'part-0001.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('uses the env dir when set, and numbers a second export started in the same second', async () => {
    const envDir = join(home, 'exports');
    const env = { OUTLOOK_OUTPUT_DIR: envDir };
    const a = await openExportSink({ ...base, env });
    const b = await openExportSink({ ...base, env });
    expect(a.dir).toBe(join(envDir, 'outlook-mail-20261020-090807'));
    expect(b.dir).toBe(join(envDir, 'outlook-mail-20261020-090807-2'));
    expect(a.exportId).not.toBe(b.exportId);
  });

  it('confines a per-call dest to ~/Downloads|Documents|Desktop when no env dir is set', async () => {
    const ok = await openExportSink({ ...base, env: {}, dest: '~/Documents/mail' });
    expect(ok.dir).toBe(join(home, 'Documents', 'mail', 'outlook-mail-20261020-090807'));
    await expect(openExportSink({ ...base, env: {}, dest: join(home, '.ssh') })).rejects.toThrow();
    await expect(openExportSink({ ...base, env: {}, dest: '/etc' })).rejects.toThrow();
    expect(existsSync(join(home, '.ssh'))).toBe(false);
  });

  it('confines a per-call dest to the env dir when one is set', async () => {
    const envDir = join(home, 'exports');
    const env = { OUTLOOK_OUTPUT_DIR: envDir };
    const ok = await openExportSink({ ...base, env, dest: join(envDir, 'sub') });
    expect(ok.dir!.startsWith(join(envDir, 'sub'))).toBe(true);
    await expect(openExportSink({ ...base, env, dest: join(home, 'Downloads') })).rejects.toThrow();
  });

  it('refuses a dest that escapes through a symlink', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'export-outside-')));
    try {
      symlinkSync(outside, join(home, 'Downloads', 'link'));
      await expect(openExportSink({ ...base, env: {}, dest: join(home, 'Downloads', 'link') })).rejects.toThrow();
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('resumes into an existing export dir, re-validated against the roots', async () => {
    const first = await openExportSink({ ...base, env: {} });
    await first.addFile('part-0001.jsonl', 'x\n');
    await first.finish();
    const resumed = await openExportSink({
      ...base,
      env: {},
      existingDir: first.dir!,
      exportId: first.exportId,
      part: 2,
    });
    expect(resumed.dir).toBe(first.dir);
    expect(resumed.exportId).toBe(first.exportId);
    expect(resumed.part).toBe(2);
    await resumed.addFile(exportPartName(2, 'jsonl'), 'y\n');
    const loc = await resumed.finish();
    expect(loc.files.map((f) => f.name)).toEqual(['part-0002.jsonl']);
    expect(readdirSync(first.dir!).sort()).toEqual(['.mcp-export', 'part-0001.jsonl', 'part-0002.jsonl']);
  });

  // chrischall/mcp-utils#391: the roots alone are broad (~/Downloads, ~/Documents,
  // ~/Desktop), so a forged cursor could aim `addFile(..., { overwrite: true })`
  // at any folder in them. Resume is bound to folders this sink created.
  it('refuses to resume into a folder the sink did not create, even inside the roots', async () => {
    const victim = join(home, 'Documents', 'taxes');
    mkdirSync(victim);
    writeFileSync(join(victim, 'part-0002.jsonl'), 'precious');
    await expect(
      openExportSink({ ...base, env: {}, existingDir: victim, exportId: 'abcdefgh12345678', part: 2 }),
    ).rejects.toBeInstanceOf(McpToolError);
    expect(readFileSync(join(victim, 'part-0002.jsonl'), 'utf8')).toBe('precious');
  });

  it('refuses a folder named like an export but without the marker', async () => {
    const lookalike = join(home, 'Downloads', 'outlook-mail-20261020-090807');
    mkdirSync(lookalike);
    await expect(
      openExportSink({ ...base, env: {}, existingDir: lookalike, exportId: 'abcdefgh12345678', part: 2 }),
    ).rejects.toBeInstanceOf(McpToolError);
  });

  it("refuses a real export dir resumed under another export's id", async () => {
    const first = await openExportSink({ ...base, env: {} });
    await first.finish();
    await expect(
      openExportSink({ ...base, env: {}, existingDir: first.dir!, exportId: 'zzzzzzzzzzzzzzzz', part: 2 }),
    ).rejects.toBeInstanceOf(McpToolError);
  });

  // fleet-audit#1452: exportId is shown in every result, so it alone does not
  // say whose folder it is. Another fleet server's export (same roots) must
  // not resume into this one.
  it("refuses another server's export dir even with that export's own id", async () => {
    const teams = await openExportSink({ ...base, name: 'microsoft-teams-mcp', baseName: 'teams-messages', env: {}, dest: join(home, 'Downloads') });
    await teams.finish();
    await expect(
      openExportSink({ ...base, env: {}, existingDir: teams.dir!, exportId: teams.exportId, part: 2 }),
    ).rejects.toBeInstanceOf(McpToolError);
    // ...and the owning server still resumes it.
    const again = await openExportSink({ ...base, name: 'microsoft-teams-mcp', baseName: 'teams-messages', env: {}, existingDir: teams.dir!, exportId: teams.exportId, part: 2 });
    expect(again.dir).toBe(teams.dir);
  });

  it('writes the server name into the marker, and refuses a marker without one', async () => {
    const first = await openExportSink({ ...base, env: {} });
    await first.finish();
    const marker = join(first.dir!, EXPORT_MARKER);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ exportId: first.exportId, name: 'office-outlook-mcp' });
    // A 3.3.0 marker named only the id: it cannot say which server owns the folder.
    writeFileSync(marker, JSON.stringify({ exportId: first.exportId }));
    await expect(
      openExportSink({ ...base, env: {}, existingDir: first.dir!, exportId: first.exportId, part: 2 }),
    ).rejects.toBeInstanceOf(McpToolError);
  });

  it('refuses a marker that is a symlink, or a dir renamed off the export name shape', async () => {
    const first = await openExportSink({ ...base, env: {} });
    await first.finish();
    const marker = join(first.dir!, '.mcp-export');
    const copy = join(home, 'marker-copy');
    writeFileSync(copy, readFileSync(marker));
    rmSync(marker);
    symlinkSync(copy, marker);
    await expect(
      openExportSink({ ...base, env: {}, existingDir: first.dir!, exportId: first.exportId, part: 2 }),
    ).rejects.toBeInstanceOf(McpToolError);

    const second = await openExportSink({ ...base, env: {} });
    await second.finish();
    const renamed = join(home, 'Downloads', 'renamed');
    renameSync(second.dir!, renamed);
    await expect(
      openExportSink({ ...base, env: {}, existingDir: renamed, exportId: second.exportId, part: 2 }),
    ).rejects.toBeInstanceOf(McpToolError);
  });

  it('never lets addFile write over the marker', async () => {
    const sink = await openExportSink({ ...base, env: {} });
    const before = readFileSync(join(sink.dir!, '.mcp-export'), 'utf8');
    await expect(sink.addFile('.mcp-export', 'x', undefined, { overwrite: true })).rejects.toBeInstanceOf(McpToolError);
    expect(readFileSync(join(sink.dir!, '.mcp-export'), 'utf8')).toBe(before);
  });

  it('refuses a resume dir outside the roots, missing, or a file — a cursor is never trusted', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'export-outside-')));
    try {
      for (const existingDir of [outside, join(home, 'Downloads', 'nope'), '/etc']) {
        await expect(
          openExportSink({ ...base, env: {}, existingDir, exportId: 'abcdefgh12345678', part: 2 }),
          existingDir,
        ).rejects.toBeInstanceOf(McpToolError);
      }
      writeFileSync(join(home, 'Downloads', 'f'), 'x');
      await expect(
        openExportSink({ ...base, env: {}, existingDir: join(home, 'Downloads', 'f'), exportId: 'abcdefgh12345678' }),
      ).rejects.toBeInstanceOf(McpToolError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses unsafe relative paths and duplicates without writing', async () => {
    const sink = await openExportSink({ ...base, env: {} });
    for (const rel of ['', '/abs', '../x', 'a/../../x', 'a\\b', 'a//b', 'a/', '.', 'a\0b']) {
      await expect(sink.addFile(rel, 'x'), JSON.stringify(rel)).rejects.toBeInstanceOf(McpToolError);
    }
    await sink.addFile('a.md', 'x');
    await expect(sink.addFile('a.md', 'y')).rejects.toBeInstanceOf(McpToolError);
    expect(readFileSync(join(sink.dir!, 'a.md'), 'utf8')).toBe('x');
    await sink.addFile('a.md', 'z', 'text/markdown', { overwrite: true });
    expect(readFileSync(join(sink.dir!, 'a.md'), 'utf8')).toBe('z');
    expect((await sink.finish()).files).toEqual([{ name: 'a.md', path: join(sink.dir!, 'a.md'), bytes: 1 }]);
  });

  it('never writes through a symlinked subdirectory planted inside the export dir', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'export-outside-')));
    try {
      const sink = await openExportSink({ ...base, env: {} });
      symlinkSync(outside, join(sink.dir!, 'attachments'));
      await expect(sink.addFile('attachments/x.txt', 'pwned')).rejects.toThrow();
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses addFile after finish and a second finish', async () => {
    const sink = await openExportSink({ ...base, env: {} });
    await sink.finish();
    await expect(sink.addFile('a.txt', 'x')).rejects.toBeInstanceOf(McpToolError);
    await expect(sink.finish()).rejects.toBeInstanceOf(McpToolError);
  });

  it('validates part and exportId', async () => {
    for (const part of [0, -1, 1.5, 10000, Number.NaN]) {
      await expect(openExportSink({ ...base, env: {}, part }), String(part)).rejects.toBeInstanceOf(McpToolError);
    }
    for (const exportId of ['short', '../../../etc', 'a b c d e f g h', 'x'.repeat(65)]) {
      await expect(openExportSink({ ...base, env: {}, exportId }), exportId).rejects.toBeInstanceOf(McpToolError);
    }
  });
});

describe('openExportSink — blob mode', () => {
  it('zips every file, PUTs part-NNNN.zip and returns a signed GET URL (no disk writes)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = await openExportSink({ ...base, env: BLOB_ENV, fetchImpl, part: 3, exportId: 'Abcdefgh_1234-xy' });
    expect(sink.mode).toBe('blob');
    expect(sink.dir).toBeUndefined();
    const text = jsonlLine({ _export: { note: 'n' } }) + jsonlLine({ id: 1, body: 'hello '.repeat(100) });
    await sink.addFile('part-0003.jsonl', text);
    await sink.addFile('attachments/a/pic.png', new Uint8Array([137, 80, 78, 71]), 'image/png');
    const loc = await sink.finish();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [putUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(new URL(putUrl).pathname).toBe('/b/reg-1234/exp/Abcdefgh_1234-xy/part-0003.zip');
    expect(new Headers(init.headers).get('content-type')).toBe('application/zip');
    const zip = new Uint8Array(init.body as ArrayBuffer);
    const files = unzip(zip);
    expect([...files.keys()]).toEqual(['part-0003.jsonl', 'attachments/a/pic.png']);
    expect(files.get('part-0003.jsonl')).toBe(text);

    const exp = NOW + 60 * 60 * 1000;
    const sig = createHmac('sha256', KEY).update(`reg-1234/exp/Abcdefgh_1234-xy/part-0003.zip\n${exp}`).digest('base64url');
    expect(loc).toEqual({
      mode: 'blob',
      exportId: 'Abcdefgh_1234-xy',
      part: 3,
      location: `${BASE}/exp/Abcdefgh_1234-xy/part-0003.zip?exp=${exp}&sig=${encodeURIComponent(sig)}`,
      key: 'exp/Abcdefgh_1234-xy/part-0003.zip',
      urlExpiresAt: new Date(exp).toISOString(),
      archiveBytes: zip.byteLength,
      bytes: Buffer.byteLength(text) + 4,
      files: [
        { name: 'part-0003.jsonl', bytes: Buffer.byteLength(text) },
        { name: 'attachments/a/pic.png', bytes: 4 },
      ],
    });
    expect(existsSync(join(home, 'Downloads', 'office-outlook-mcp'))).toBe(false);
  });

  it('honours a custom TTL and refuses one past the gateway maximum', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = await openExportSink({ ...base, env: BLOB_ENV, fetchImpl, ttlMs: 2 * 60 * 60 * 1000 });
    await sink.addFile('a.md', '# x');
    const loc = await sink.finish();
    expect(loc.urlExpiresAt).toBe(new Date(NOW + 2 * 60 * 60 * 1000).toISOString());
    await expect(openExportSink({ ...base, env: BLOB_ENV, fetchImpl, ttlMs: 25 * 60 * 60 * 1000 })).rejects.toBeInstanceOf(
      McpToolError,
    );
  });

  it('surfaces an upload failure as McpToolError without the signature', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 500 }));
    const sink = await openExportSink({ ...base, env: BLOB_ENV, fetchImpl });
    await sink.addFile('a.md', 'x');
    const err = await sink.finish().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).not.toContain('sig=');
  });

  it('refuses unsafe names and duplicates; overwrite replaces the entry', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = await openExportSink({ ...base, env: BLOB_ENV, fetchImpl });
    await expect(sink.addFile('../x', 'x')).rejects.toBeInstanceOf(McpToolError);
    await sink.addFile('manifest.json', '{}');
    await expect(sink.addFile('manifest.json', '{}')).rejects.toBeInstanceOf(McpToolError);
    await sink.addFile('manifest.json', '{"a":1}', 'application/json', { overwrite: true });
    const loc = await sink.finish();
    expect(loc.files).toEqual([{ name: 'manifest.json', bytes: 7 }]);
    const zip = new Uint8Array((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as ArrayBuffer);
    expect(unzip(zip).get('manifest.json')).toBe('{"a":1}');
  });

  // fleet-audit#1441: blob mode holds every file in memory until finish, so
  // it is bounded — a hosted child's memory is not the caller's budget.
  it('refuses a file that would take the part past maxBytes, naming the way out', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = await openExportSink({ ...base, env: BLOB_ENV, fetchImpl, maxBytes: 10 });
    await sink.addFile('a.txt', '123456');
    const err = await sink.addFile('b.txt', '12345').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
    expect((err as McpToolError).hint).toMatch(/finish/i);
    // An overwrite counts the replacement, not both copies.
    await sink.addFile('a.txt', '1234567890', undefined, { overwrite: true });
    await expect(sink.addFile('c.txt', 'x')).rejects.toBeInstanceOf(McpToolError);
    const loc = await sink.finish();
    expect(loc.files).toEqual([{ name: 'a.txt', bytes: 10 }]);
  });

  it('bounds a blob part at 256 MiB by default, and refuses a nonsense maxBytes', async () => {
    expect(EXPORT_BLOB_MAX_BYTES).toBe(256 * 1024 * 1024);
    for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(openExportSink({ ...base, env: BLOB_ENV, maxBytes })).rejects.toThrow(/maxBytes/);
    }
  });

  it('does not bound disk mode, which streams each file to disk', async () => {
    const sink = await openExportSink({ ...base, env: {}, maxBytes: 4 });
    await sink.addFile('a.txt', '12345678');
    expect((await sink.finish()).bytes).toBe(8);
  });

  it('ignores dest/existingDir in blob mode (nothing touches disk)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = await openExportSink({ ...base, env: BLOB_ENV, fetchImpl, dest: '/etc', existingDir: '/etc' });
    expect(sink.mode).toBe('blob');
  });
});

describe('exportAllowedRoots', () => {
  it('is the env dir when set, else Downloads/Documents/Desktop', () => {
    expect(exportAllowedRoots('X_DIR', { X_DIR: '/data/x' })).toEqual(['/data/x']);
    expect(exportAllowedRoots('X_DIR', { X_DIR: '${X_DIR}' })).toEqual([
      join(home, 'Downloads'),
      join(home, 'Documents'),
      join(home, 'Desktop'),
    ]);
  });
});

describe('export cursor codec', () => {
  it('round-trips with a version field', () => {
    const c = encodeExportCursor({ exportId: 'abc', part: 2, pos: { from: 'x' } });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeExportCursor(c)).toEqual({ v: 1, exportId: 'abc', part: 2, pos: { from: 'x' } });
  });

  it('refuses an oversized cursor at encode time', () => {
    expect(() => encodeExportCursor({ big: 'x'.repeat(EXPORT_CURSOR_MAX_LENGTH) })).toThrow(TypeError);
  });

  it.each([
    ['', 'empty'],
    ['not base64!', 'bad charset'],
    [Buffer.from('not json').toString('base64url'), 'not JSON'],
    [Buffer.from('[1,2]').toString('base64url'), 'array'],
    [Buffer.from('null').toString('base64url'), 'null'],
    [Buffer.from('{"v":2}').toString('base64url'), 'wrong version'],
    [Buffer.from('{"a":1}').toString('base64url'), 'no version'],
    ['A'.repeat(EXPORT_CURSOR_MAX_LENGTH + 1), 'too long'],
  ])('throws McpToolError on garbage: %j (%s)', (s) => {
    expect(() => decodeExportCursor(s)).toThrow(McpToolError);
  });

  it('throws on a non-string', () => {
    expect(() => decodeExportCursor(42 as unknown as string)).toThrow(McpToolError);
  });
});

describe('jsonlLine', () => {
  it('serializes one record per line; embedded newlines stay escaped', () => {
    expect(jsonlLine({ a: 'x\ny', b: [1] })).toBe('{"a":"x\\ny","b":[1]}\n');
    expect(jsonlLine({ s: 'a b' }).split('\n')).toHaveLength(2);
  });

  it('refuses a value with no JSON form', () => {
    expect(() => jsonlLine(undefined)).toThrow(TypeError);
  });
});

describe('exportPartName / sanitizeExportFileName', () => {
  it('zero-pads part numbers', () => {
    expect(exportPartName(1, 'jsonl')).toBe('part-0001.jsonl');
    expect(exportPartName(42, 'zip')).toBe('part-0042.zip');
    expect(() => exportPartName(0, 'md')).toThrow(TypeError);
    expect(() => exportPartName(1, '../x')).toThrow(TypeError);
  });

  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', '_etc_passwd'],
    ['a/b\\c:d*e?f"g<h>i|j.txt', 'a_b_c_d_e_f_g_h_i_j.txt'],
    ['  .hidden  ', 'hidden'],
    ['tab\there\u0000.txt', 'tab_here_.txt'],
    ['', 'file'],
    ['...', 'file'],
    ['Q3 report (final).docx', 'Q3 report (final).docx'],
  ])('%j → %j', (input, want) => {
    expect(sanitizeExportFileName(input)).toBe(want);
  });

  it('caps the length but keeps the extension', () => {
    const out = sanitizeExportFileName(`${'n'.repeat(300)}.xlsx`);
    expect(out.length).toBe(120);
    expect(out.endsWith('.xlsx')).toBe(true);
  });
});
