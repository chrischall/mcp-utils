import { describe, expect, it, vi } from 'vitest';

// Simulate a consumer that never installed the optional peer @napi-rs/canvas.
vi.mock('@napi-rs/canvas', () => {
  throw Object.assign(new Error("Cannot find package '@napi-rs/canvas'"), { code: 'ERR_MODULE_NOT_FOUND' });
});

const { makePdf } = await import('./make-pdf.fixture.js');
const { convertPdf } = await import('./pdf.js');
const { PDF_IMAGES_UNAVAILABLE_NOTE, renderPdfPages } = await import('./pdf-images.js');

describe('PDF page images without @napi-rs/canvas', () => {
  it('renderPdfPages degrades to a note instead of throwing', async () => {
    const r = await renderPdfPages(makePdf(['a']), [1]);
    expect(r).toEqual({ images: [], notes: [PDF_IMAGES_UNAVAILABLE_NOTE] });
  });

  it('mode images falls back to the text layer, with the note', async () => {
    const r = await convertPdf(makePdf(['Hello there']), 'images');
    expect(r.parts.map((p) => p.type)).toEqual(['text']);
    expect(r.notes).toContain(PDF_IMAGES_UNAVAILABLE_NOTE);
    expect(r.notes).toContain('returned the text layer instead of page images');
  });

  it('mode auto on a scanned PDF still returns its text with the note', async () => {
    const r = await convertPdf(makePdf(['']), 'auto');
    expect(r.parts.map((p) => p.type)).toEqual(['text']);
    expect(r.notes).toContain(PDF_IMAGES_UNAVAILABLE_NOTE);
  });
});
