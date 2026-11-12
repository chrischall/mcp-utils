import { describe, expect, it } from 'vitest';
import { makePdf } from './make-pdf.fixture.js';
import { PDF_IMAGE_MAX_SIDE, PDF_IMAGES_UNAVAILABLE_NOTE, renderPdfPages } from './pdf-images.js';
import type { ConvertedPart } from './types.js';

type ImagePart = Extract<ConvertedPart, { type: 'image' }>;

/** Width and height from a JPEG's first SOFn marker. */
function jpegSize(data: Uint8Array): { width: number; height: number } {
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) throw new Error(`bad JPEG marker at ${i}`);
    const marker = data[i + 1]!;
    const len = (data[i + 2]! << 8) | data[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (data[i + 5]! << 8) | data[i + 6]!, width: (data[i + 7]! << 8) | data[i + 8]! };
    }
    i += 2 + len;
  }
  throw new Error('no SOF marker');
}

function images(parts: ConvertedPart[]): ImagePart[] {
  return parts.filter((p): p is ImagePart => p.type === 'image');
}

describe('renderPdfPages', () => {
  it('renders each requested page as a JPEG no larger than 1600 px on its longer side', async () => {
    const r = await renderPdfPages(makePdf(['one', 'two', 'three']), [1, 2, 3], {}, undefined, { fileName: 'Report Q3.pdf' });
    const imgs = images(r.images);
    expect(imgs).toHaveLength(3);
    expect(imgs.map((p) => p.name)).toEqual(['Report Q3-page-1.jpg', 'Report Q3-page-2.jpg', 'Report Q3-page-3.jpg']);
    expect(PDF_IMAGE_MAX_SIDE).toBe(1600);
    for (const p of imgs) {
      expect(p.mimeType).toBe('image/jpeg');
      expect(Array.from(p.data.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
      const { width, height } = jpegSize(p.data);
      expect(Math.max(width, height)).toBeLessThanOrEqual(1600);
      expect(Math.max(width, height)).toBeGreaterThan(1500);
      // Letter portrait keeps its aspect ratio.
      expect(height).toBeGreaterThan(width);
    }
    expect(r.notes).toEqual([]);
  });

  it('names images document-page-N.jpg without a file name', async () => {
    const r = await renderPdfPages(makePdf(['x']), [1]);
    expect(r.images[0]?.name).toBe('document-page-1.jpg');
  });

  it('stops at maxImages and notes the pages not rendered', async () => {
    const r = await renderPdfPages(makePdf(['a', 'b', 'c', 'd']), [1, 2, 3, 4], { maxImages: 2 });
    expect(r.images).toHaveLength(2);
    expect(r.notes).toEqual(['pages 3–4 not rendered (maxImages is 2)']);
  });

  it('stops before maxImageBytes would be exceeded and notes it', async () => {
    const one = await renderPdfPages(makePdf(['a']), [1]);
    const size = (one.images[0] as ImagePart).data.length;
    const r = await renderPdfPages(makePdf(['a', 'a', 'a']), [1, 2, 3], { maxImageBytes: size + Math.floor(size / 2) });
    expect(r.images).toHaveLength(1);
    expect(r.notes).toEqual([`pages 2–3 not rendered (the ${size + Math.floor(size / 2)}-byte image cap was reached)`]);
  });

  it('skips page numbers outside the document with a note', async () => {
    const r = await renderPdfPages(makePdf(['a', 'b']), [2, 5]);
    expect(r.images.map((p) => p.name)).toEqual(['document-page-2.jpg']);
    expect(r.notes).toEqual(['page 5 not rendered (the PDF has 2 pages)']);
  });

  it('degrades to no images and a note when @napi-rs/canvas cannot be imported', async () => {
    const missing = Object.assign(new Error("Cannot find package '@napi-rs/canvas'"), { code: 'ERR_MODULE_NOT_FOUND' });
    const r = await renderPdfPages(makePdf(['a']), [1], {}, undefined, { canvasImport: () => Promise.reject(missing) });
    expect(r.images).toEqual([]);
    expect(r.notes).toEqual([PDF_IMAGES_UNAVAILABLE_NOTE]);
    expect(PDF_IMAGES_UNAVAILABLE_NOTE).toBe('page images unavailable: install @napi-rs/canvas');
  });

  it('degrades (never throws) when the canvas import fails for another reason', async () => {
    const r = await renderPdfPages(makePdf(['a']), [1], {}, undefined, { canvasImport: () => Promise.reject(new Error('dlopen failed')) });
    expect(r.images).toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^page images unavailable: @napi-rs\/canvas could not be loaded/);
  });

  it('returns nothing when no pages are asked for', async () => {
    expect(await renderPdfPages(makePdf(['a']), [])).toEqual({ images: [], notes: [] });
  });

  it('honours an aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(renderPdfPages(makePdf(['a']), [1], {}, ac.signal)).rejects.toThrow();
  });
});
