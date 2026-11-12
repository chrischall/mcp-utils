import ExcelJS from 'exceljs';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { McpToolError } from '../errors/index.js';
import type { ConvertedPart } from './types.js';
import { convertXlsx, sheetFileName } from './xlsx.js';

async function book(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

function text(part: ConvertedPart | undefined): string {
  if (part?.type !== 'text') throw new Error('expected a text part');
  return part.text;
}

describe('convertXlsx', () => {
  it('writes one CSV part per sheet, in workbook order, with a unicode sheet name', async () => {
    const bytes = await book((wb) => {
      wb.addWorksheet('First').addRow(['a', 'b']);
      wb.addWorksheet('Données €').addRow(['x']);
    });
    const r = await convertXlsx(bytes);
    expect(r.format).toBe('xlsx');
    expect(r.count).toBe(2);
    expect(r.parts.map((p) => [p.name, p.mimeType])).toEqual([
      ['First.csv', 'text/csv'],
      ['Données €.csv', 'text/csv'],
    ]);
    expect(text(r.parts[0])).toBe('a,b\r\n');
    expect(text(r.parts[1])).toBe('x\r\n');
    expect(r.notes).toEqual([]);
  });

  it('renders formulas, rich text, hyperlinks, dates, errors, booleans and numbers', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('Values');
      ws.addRow([
        1,
        2,
        { formula: 'A1+B1', result: 3 },
        { richText: [{ text: 'Hello ' }, { font: { bold: true }, text: 'World' }] },
        { text: 'Site', hyperlink: 'https://example.com' },
        new Date(Date.UTC(2024, 0, 15)),
        new Date(Date.UTC(2024, 0, 15, 13, 45, 30)),
        { error: '#DIV/0!' },
        true,
        false,
        1.5,
      ]);
    });
    const r = await convertXlsx(bytes);
    expect(text(r.parts[0])).toBe('1,2,3,Hello World,Site,2024-01-15,2024-01-15T13:45:30.000Z,#DIV/0!,TRUE,FALSE,1.5\r\n');
  });

  it('quotes commas, quotes, newlines and edge whitespace (RFC 4180)', async () => {
    const bytes = await book((wb) => {
      wb.addWorksheet('Q').addRow(['a,b', 'say "hi"', 'two\nlines', ' pad ']);
    });
    const r = await convertXlsx(bytes);
    expect(text(r.parts[0])).toBe('"a,b","say ""hi""","two\nlines"," pad "\r\n');
  });

  it('keeps interior blanks, pads ragged rows, and drops trailing empty rows and columns', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('Gaps');
      ws.getCell('A1').value = 'a';
      ws.getCell('C1').value = 'c';
      ws.getCell('B3').value = 'b3';
      ws.getCell('F10').value = null;
      ws.getRow(12).getCell(8).value = '';
    });
    const r = await convertXlsx(bytes);
    expect(text(r.parts[0])).toBe('a,,c\r\n,,\r\n,b3,\r\n');
  });

  it('includes hidden sheets but notes them', async () => {
    const bytes = await book((wb) => {
      wb.addWorksheet('Shown').addRow(['s']);
      wb.addWorksheet('Secret', { state: 'hidden' }).addRow(['h']);
    });
    const r = await convertXlsx(bytes);
    expect(r.parts).toHaveLength(2);
    expect(text(r.parts[1])).toBe('h\r\n');
    expect(r.notes.join('\n')).toMatch(/Secret.*hidden/);
  });

  it('cuts at a row boundary when maxTextBytes bites, marks the part truncated and notes it', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('Big');
      for (let i = 1; i <= 100; i++) ws.addRow([`row${i}`, 'xxxxxxxxxx']);
      wb.addWorksheet('After').addRow(['never']);
    });
    const r = await convertXlsx(bytes, { maxTextBytes: 200 });
    const first = r.parts[0];
    expect(first?.type === 'text' && first.truncated).toBe(true);
    const csv = text(first);
    expect(Buffer.byteLength(csv)).toBeLessThanOrEqual(200);
    expect(csv.endsWith('\r\n')).toBe(true);
    const kept = csv.split('\r\n').length - 1;
    expect(r.parts).toHaveLength(1);
    const notes = r.notes.join('\n');
    expect(notes).toContain(`"Big": kept rows 1–${kept} of 100`);
    expect(notes).toMatch(/"After".*not converted/);
  });

  it('says no rows were kept when even the first row is over the text cap', async () => {
    const bytes = await book((wb) => {
      wb.addWorksheet('Wide').addRow(['x'.repeat(50), 'y']);
    });
    const r = await convertXlsx(bytes, { maxTextBytes: 10 });
    expect(r.parts[0]).toMatchObject({ name: 'Wide.csv', text: '', truncated: true });
    expect(r.notes).toContain('sheet "Wide": no rows kept of 1 (the 10-byte text cap was reached)');
  });

  it('reads at most maxPages sheets and notes the rest', async () => {
    const bytes = await book((wb) => {
      for (const n of ['S1', 'S2', 'S3']) wb.addWorksheet(n).addRow([n]);
    });
    const r = await convertXlsx(bytes, { maxPages: 2 });
    expect(r.parts.map((p) => p.name)).toEqual(['S1.csv', 'S2.csv']);
    expect(r.count).toBe(3);
    expect(r.notes.join('\n')).toMatch(/1 sheet.*not read.*S3/);
  });

  it('refuses a zip bomb before exceljs loads it', async () => {
    const bomb = zipSync({ '[Content_Types].xml': new Uint8Array(4 * 1024 * 1024) });
    const err = await convertXlsx(bomb, { maxUnzippedBytes: 1024 * 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
  });

  it('stays cheap on a tiny workbook with one cell in a far corner', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('Sparse');
      ws.getCell('A1').value = 'a';
      ws.getCell(1048576, 16384).value = 'z'; // XFD1048576
    });
    const t = Date.now();
    const r = await convertXlsx(bytes, { maxTextBytes: 64 * 1024 });
    expect(Date.now() - t).toBeLessThan(5000);
    const part = r.parts[0];
    expect(part?.truncated).toBe(true);
    expect(Buffer.byteLength(text(part))).toBeLessThanOrEqual(64 * 1024);
    expect(text(part).startsWith('a,')).toBe(true);
    expect(r.notes.join('\n')).toMatch(/of 1048576/);
  }, 20000);

  it('refuses input over maxInputBytes', async () => {
    const bytes = await book((wb) => {
      wb.addWorksheet('A').addRow(['a']);
    });
    await expect(convertXlsx(bytes, { maxInputBytes: 10 })).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('turns a zip that is not a workbook into a clear McpToolError', async () => {
    const notBook = zipSync({ 'hello.txt': new TextEncoder().encode('hi') });
    const err = await convertXlsx(notBook).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/workbook/i);
  });

  it('honours an aborted signal', async () => {
    const bytes = await book((wb) => {
      wb.addWorksheet('A').addRow(['a']);
    });
    await expect(convertXlsx(bytes, {}, AbortSignal.abort())).rejects.toThrow();
  });
});

describe('sheetFileName', () => {
  it('replaces characters unsafe in file names', () => {
    expect(sheetFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j.csv');
  });
});

describe('convertXlsx archive handling', () => {
  it('refuses a workbook whose EOCD hides a zip bomb behind an understated entry count', async () => {
    const files = unzipSync(await book((wb) => wb.addWorksheet('A').addRow(['a'])));
    const z = zipSync({ ...files, 'zz/bomb.bin': new Uint8Array(8 * 1024 * 1024) });
    const v = new DataView(z.buffer);
    const e = z.length - 22;
    const n = v.getUint16(e + 10, true);
    v.setUint16(e + 8, n - 1, true);
    v.setUint16(e + 10, n - 1, true);
    await expect(convertXlsx(z, { maxUnzippedBytes: 1024 * 1024 })).rejects.toBeInstanceOf(McpToolError);
  });

  it('reads a workbook whose entry names carry a leading slash', async () => {
    const files = unzipSync(await book((wb) => wb.addWorksheet('S').addRow(['x', 'y'])));
    const slashed = Object.fromEntries(Object.entries(files).map(([k, v]) => [`/${k}`, v]));
    const r = await convertXlsx(zipSync(slashed));
    expect(text(r.parts[0])).toBe('x,y\r\n');
  });
});
