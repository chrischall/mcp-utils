import ExcelJS from 'exceljs';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { McpToolError } from '../errors/index.js';
import * as convert from './index.js';
import { makePdf } from './make-pdf.fixture.js';

describe('@chrischall/mcp-utils/convert barrel', () => {
  it('exports the xlsx and pdf converters, CSV writer, zip reader and limits', () => {
    expect(typeof convert.convertXlsx).toBe('function');
    expect(typeof convert.toCsv).toBe('function');
    expect(typeof convert.openZip).toBe('function');
    expect(typeof convert.convertPdf).toBe('function');
    expect(typeof convert.extractPdfText).toBe('function');
    expect(typeof convert.isTextSparse).toBe('function');
    expect(typeof convert.convertPptx).toBe('function');
    expect(convert.PDF_SPARSE_CHARS_PER_PAGE).toBe(80);
    expect(convert.DEFAULT_CONVERT_LIMITS.maxTextBytes).toBe(200 * 1024);
    expect(convert.ZIP_ENTRY_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(typeof convert.convertAttachment).toBe('function');
    expect(typeof convert.convertedToContent).toBe('function');
    expect(typeof convert.detectConvertible).toBe('function');
  });

  it('resolveConvertLimits fills defaults and ignores invalid values', () => {
    const l = convert.resolveConvertLimits({ maxImages: 3, maxPages: -1, maxTextBytes: Number.NaN });
    expect(l.maxImages).toBe(3);
    expect(l.maxPages).toBe(convert.DEFAULT_CONVERT_LIMITS.maxPages);
    expect(l.maxTextBytes).toBe(convert.DEFAULT_CONVERT_LIMITS.maxTextBytes);
    expect(l.maxUnzippedBytes).toBe(200 * 1024 * 1024);
  });
});

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSM_MIME = 'application/vnd.ms-excel.sheet.macroEnabled.12';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

async function workbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Sheet A').addRow(['a', 'b']);
  wb.addWorksheet('Sheet B').addRow(['c']);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function deck(): Uint8Array {
  const enc = new TextEncoder();
  return zipSync({
    'ppt/presentation.xml': enc.encode(
      `<p:presentation ${P_NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    ),
    'ppt/_rels/presentation.xml.rels': enc.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`,
    ),
    'ppt/slides/slide1.xml': enc.encode(
      `<p:sld ${P_NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Quarterly plan</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ),
  });
}

describe('detectConvertible', () => {
  it.each([
    ['a.bin', 'application/pdf', 'pdf'],
    ['a.bin', 'Application/PDF; name="x.pdf"', 'pdf'],
    ['a', XLSX_MIME, 'xlsx'],
    ['a', XLSM_MIME, 'xlsx'],
    ['a', PPTX_MIME, 'pptx'],
    ['Report.PDF', undefined, 'pdf'],
    ['book.xlsx', 'application/octet-stream', 'xlsx'],
    ['book.xlsm', '', 'xlsx'],
    ['deck.pptx', undefined, 'pptx'],
  ] as const)('%s / %s → %s', (name, mime, want) => {
    expect(convert.detectConvertible(name, mime)).toBe(want);
  });

  it.each([
    ['notes.txt', undefined],
    ['old.xls', undefined],
    ['old.ppt', 'application/vnd.ms-powerpoint'],
    ['image.png', 'image/png'],
    // A specific, non-convertible MIME wins over the extension.
    ['spoof.pdf', 'text/plain'],
    ['noext', undefined],
  ] as const)('%s / %s → undefined', (name, mime) => {
    expect(convert.detectConvertible(name, mime)).toBeUndefined();
  });
});

describe('convertAttachment', () => {
  it('returns undefined for a format it cannot convert', async () => {
    const r = await convert.convertAttachment({ bytes: new TextEncoder().encode('hi'), fileName: 'a.txt', mimeType: 'text/plain' });
    expect(r).toBeUndefined();
  });

  it('returns undefined when the magic bytes do not match the claimed format', async () => {
    const zip = await workbook();
    expect(await convert.convertAttachment({ bytes: zip, fileName: 'fake.pdf' })).toBeUndefined();
    expect(await convert.convertAttachment({ bytes: makePdf(['Hi']), fileName: 'fake.xlsx' })).toBeUndefined();
    expect(await convert.convertAttachment({ bytes: new Uint8Array(), fileName: 'empty.pptx' })).toBeUndefined();
  });

  it('throws a too_large McpToolError naming the size and cap for an oversized input', async () => {
    const bytes = makePdf(['Hello']);
    const err = await convert
      .convertAttachment({ bytes, fileName: 'a.pdf', limits: { maxInputBytes: 10 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
    expect((err as Error).message).toContain(String(bytes.length));
    expect((err as Error).message).toContain('10');
  });

  it('converts a PDF to markdown named after the file, with a page count', async () => {
    const r = await convert.convertAttachment({ bytes: makePdf(['Hello world, this is the text layer of a real PDF page. '.repeat(3)]), fileName: 'Letter.pdf', mode: 'text' });
    expect(r?.format).toBe('pdf');
    expect(r?.count).toBe(1);
    const part = r?.parts[0];
    expect(part?.type).toBe('text');
    expect(part?.name).toBe('Letter.md');
    expect(part?.type === 'text' && part.text).toContain('Hello world');
  });

  it('converts a workbook to one CSV per sheet', async () => {
    const r = await convert.convertAttachment({ bytes: await workbook(), fileName: 'book.xlsx' });
    expect(r?.format).toBe('xlsx');
    expect(r?.count).toBe(2);
    expect(r?.parts.map((p) => p.name)).toEqual(['Sheet A.csv', 'Sheet B.csv']);
  });

  it('converts a deck to markdown named after the file', async () => {
    const r = await convert.convertAttachment({ bytes: deck(), fileName: 'Plan.pptx', mimeType: PPTX_MIME });
    expect(r?.format).toBe('pptx');
    expect(r?.count).toBe(1);
    expect(r?.parts[0]?.name).toBe('Plan.md');
    expect(r?.parts[0]?.type === 'text' && r.parts[0].text).toContain('Quarterly plan');
  });

  it("treats mode 'images' as 'auto' for workbooks and decks, with a note", async () => {
    const x = await convert.convertAttachment({ bytes: await workbook(), fileName: 'book.xlsx', mode: 'images' });
    expect(x?.parts.every((p) => p.type === 'text')).toBe(true);
    expect(x?.notes.some((n) => n.includes("'images'"))).toBe(true);
    const p = await convert.convertAttachment({ bytes: deck(), fileName: 'd.pptx', mode: 'images' });
    expect(p?.parts[0]?.type).toBe('text');
    expect(p?.notes.some((n) => n.includes("'images'"))).toBe(true);
  });

  it('honours an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(convert.convertAttachment({ bytes: makePdf(['x']), fileName: 'a.pdf', signal: ac.signal })).rejects.toThrow();
  });
});

describe('convertedToContent', () => {
  it('maps text parts with a header, images to base64, and lists notes last', () => {
    const r: convert.ConvertResult = {
      format: 'pptx',
      count: 2,
      parts: [
        { type: 'text', name: 'deck.md', mimeType: 'text/markdown', text: '## Slide 1' },
        { type: 'text', name: 'Sheet.csv', mimeType: 'text/csv', text: 'a,b', truncated: true },
        { type: 'image', name: 'slide1-image1.png', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) },
      ],
      notes: ['slide 2 skipped', 'image cap reached'],
    };
    expect(convert.convertedToContent(r)).toEqual([
      { type: 'text', text: '--- deck.md (text/markdown) ---\n## Slide 1' },
      { type: 'text', text: '--- Sheet.csv (text/csv, truncated) ---\na,b' },
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
      { type: 'text', text: 'Notes:\n- slide 2 skipped\n- image cap reached' },
    ]);
  });

  it('adds no notes block when there are no notes', () => {
    const out = convert.convertedToContent({ format: 'pdf', parts: [], notes: [] });
    expect(out).toEqual([]);
  });
});
