import { describe, expect, it } from 'vitest';
import { McpToolError } from '../errors/index.js';
import { makePdf } from './make-pdf.fixture.js';
import { convertPdf, extractPdfText, isTextSparse, PDF_SPARSE_CHARS_PER_PAGE } from './pdf.js';
import type { ConvertedPart } from './types.js';

function text(part: ConvertedPart | undefined): string {
  if (part?.type !== 'text') throw new Error('expected a text part');
  return part.text;
}

const words = (n: number, seed = 'word') => Array.from({ length: n }, (_, i) => `${seed}${i}`);
/** `n` words, six to a line (a fixture line must stay inside the 612 pt page). */
const para = (n: number, seed = 'word') => {
  const w = words(n, seed);
  const lines: string[] = [];
  for (let i = 0; i < w.length; i += 6) lines.push(w.slice(i, i + 6).join(' '));
  return lines.join('\n');
};

describe('extractPdfText', () => {
  it('returns one string per page, lines joined by y-position', async () => {
    const bytes = makePdf(['Hello world\nSecond line', 'Page two']);
    const r = await extractPdfText(bytes);
    expect(r.pageCount).toBe(2);
    expect(r.pages).toEqual(['Hello world\nSecond line', 'Page two']);
  });

  it('keeps a blank line between paragraphs and collapses runs of spaces', async () => {
    const r = await extractPdfText(makePdf(['First   para\n\nSecond para']));
    expect(r.pages[0]).toBe('First para\n\nSecond para');
  });

  it('reads only the first maxPages pages but reports the full count', async () => {
    const r = await extractPdfText(makePdf(['a', 'b', 'c']), { maxPages: 2 });
    expect(r.pageCount).toBe(3);
    expect(r.pages).toEqual(['a', 'b']);
  });

  it('does not detach the caller’s buffer', async () => {
    const bytes = makePdf(['x']);
    await extractPdfText(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
  });

  it('throws a clear McpToolError for a corrupt PDF', async () => {
    const bad = new TextEncoder().encode('%PDF-1.4\nthis is not really a pdf at all');
    const err = await extractPdfText(bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/^Could not read the PDF/);
  });

  it('refuses an input over maxInputBytes', async () => {
    const err = await extractPdfText(makePdf(['x']), { maxInputBytes: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
  });

  it('honours an aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(extractPdfText(makePdf(['x']), {}, ac.signal)).rejects.toThrow();
  });
});

describe('isTextSparse', () => {
  it('is true when pages average fewer than the threshold of non-whitespace characters', () => {
    expect(PDF_SPARSE_CHARS_PER_PAGE).toBe(80);
    expect(isTextSparse([])).toBe(true);
    expect(isTextSparse(['', '  \n '])).toBe(true);
    expect(isTextSparse(['x'.repeat(79)])).toBe(true);
    expect(isTextSparse(['x'.repeat(80)])).toBe(false);
    expect(isTextSparse(['x'.repeat(160), ''])).toBe(false);
    expect(isTextSparse([`${' a'.repeat(100)}`])).toBe(false);
  });
});

describe('convertPdf', () => {
  it('writes one markdown part with a heading per page', async () => {
    const bytes = makePdf([para(20, 'alpha'), para(20, 'beta')]);
    const r = await convertPdf(bytes, 'text', undefined, undefined, 'Report Q3.pdf');
    expect(r.format).toBe('pdf');
    expect(r.count).toBe(2);
    expect(r.parts).toHaveLength(1);
    const p = r.parts[0]!;
    expect(p).toMatchObject({ type: 'text', name: 'Report Q3.md', mimeType: 'text/markdown' });
    expect(text(p)).toBe(`## Page 1\n\n${para(20, 'alpha')}\n\n## Page 2\n\n${para(20, 'beta')}\n`);
    expect(r.notes).toEqual([]);
    expect('truncated' in p).toBe(false);
  });

  it('defaults the part name when no file name is given', async () => {
    const r = await convertPdf(makePdf([para(20)]));
    expect(r.parts[0]!.name).toBe('document.md');
  });

  it('notes the pages it did not read when maxPages bites', async () => {
    const bytes = makePdf([para(20, 'a'), para(20, 'b'), para(20, 'c'), para(20, 'd')]);
    const r = await convertPdf(bytes, 'text', { maxPages: 2 });
    expect(r.count).toBe(4);
    expect(text(r.parts[0])).toContain('## Page 2');
    expect(text(r.parts[0])).not.toContain('## Page 3');
    expect(r.notes).toContain('pages 3–4 not read (maxPages is 2)');
  });

  it('names a single unread page', async () => {
    const r = await convertPdf(makePdf([para(20, 'a'), para(20, 'b')]), 'text', { maxPages: 1 });
    expect(r.notes).toContain('page 2 not read (maxPages is 1)');
  });

  it('cuts at a line boundary when maxTextBytes bites, and says so', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i} ${words(6).join(' ')}`);
    const bytes = makePdf([lines.join('\n'), para(20, 'next')]);
    const r = await convertPdf(bytes, 'text', { maxTextBytes: 600 });
    const p = r.parts[0]!;
    expect(p).toMatchObject({ truncated: true });
    const t = text(p);
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(600);
    expect(t.startsWith('## Page 1\n\nline 0 ')).toBe(true);
    // Whole lines only.
    for (const l of t.split('\n').filter((x) => x.startsWith('line '))) expect(lines).toContain(l);
    expect(t).not.toContain('## Page 2');
    expect(r.notes.some((n) => /page 1: kept lines 1–\d+ of 30/.test(n) && n.includes('600-byte text cap'))).toBe(true);
    expect(r.notes.some((n) => n.includes('page 2 not included'))).toBe(true);
  });

  it('cuts at a page boundary when the next page does not fit at all', async () => {
    const bytes = makePdf([para(10, 'a'), para(200, 'b'), para(10, 'c')]);
    const first = `## Page 1\n\n${para(10, 'a')}\n\n`;
    const r = await convertPdf(bytes, 'text', { maxTextBytes: Buffer.byteLength(first) + 15 });
    const t = text(r.parts[0]);
    expect(t).toBe(first.trimEnd() + '\n');
    expect(r.parts[0]).toMatchObject({ truncated: true });
    expect(r.notes.some((n) => n.includes('pages 2–3 not included'))).toBe(true);
  });

  it('notes a PDF with little or no text layer (likely scanned)', async () => {
    const r = await convertPdf(makePdf(['', '']), 'auto');
    expect(r.count).toBe(2);
    expect(r.notes).toContain('this PDF has little or no text layer (likely scanned)');
    expect(text(r.parts[0])).toBe('## Page 1\n\n## Page 2\n');
  });

  it('does not flag a PDF with a real text layer as scanned', async () => {
    const r = await convertPdf(makePdf([para(30)]), 'auto');
    expect(r.notes.some((n) => n.includes('likely scanned'))).toBe(false);
  });

  it('returns only page images for mode images, with a note of the page count', async () => {
    const r = await convertPdf(makePdf([para(30), 'two', 'three']), 'images', {}, undefined, 'Deck.pdf');
    expect(r.parts.map((p) => [p.type, p.name])).toEqual([
      ['image', 'Deck-page-1.jpg'],
      ['image', 'Deck-page-2.jpg'],
      ['image', 'Deck-page-3.jpg'],
    ]);
    expect(r.count).toBe(3);
    expect(r.notes).toContain('the PDF has 3 pages; returned page images only');
  });

  it('renders at most maxImages pages for mode images and notes the rest', async () => {
    const r = await convertPdf(makePdf(['a', 'b', 'c']), 'images', { maxImages: 2 });
    expect(r.parts.filter((p) => p.type === 'image')).toHaveLength(2);
    expect(r.notes).toContain('page 3 not rendered (maxImages is 2)');
  });

  it('renders no more than maxPages pages for mode images', async () => {
    const r = await convertPdf(makePdf(['a', 'b', 'c']), 'images', { maxPages: 1 });
    expect(r.parts.filter((p) => p.type === 'image')).toHaveLength(1);
    expect(r.notes).toContain('pages 2–3 not rendered (maxPages is 1)');
  });

  it('adds page images to the text for a sparse (scanned) PDF in mode auto', async () => {
    const r = await convertPdf(makePdf(['', '']), 'auto', {}, undefined, 'scan.pdf');
    expect(r.parts.map((p) => [p.type, p.name])).toEqual([
      ['text', 'scan.md'],
      ['image', 'scan-page-1.jpg'],
      ['image', 'scan-page-2.jpg'],
    ]);
    expect(r.notes).toContain('this PDF has little or no text layer (likely scanned)');
  });

  it('adds no images in mode auto when the text layer is real', async () => {
    const r = await convertPdf(makePdf([para(30)]), 'auto');
    expect(r.parts.every((p) => p.type === 'text')).toBe(true);
  });

  it('never renders images in mode text, even for a sparse PDF', async () => {
    const r = await convertPdf(makePdf(['']), 'text');
    expect(r.parts.every((p) => p.type === 'text')).toBe(true);
  });

  it('throws a clear McpToolError for a corrupt PDF', async () => {
    const err = await convertPdf(new Uint8Array([1, 2, 3, 4]), 'text').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/^Could not read the PDF/);
    expect((err as Error).message).not.toMatch(/\n\s+at /);
  });
});
