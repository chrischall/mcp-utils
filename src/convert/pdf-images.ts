/**
 * PDF pages → images, for PDFs whose text layer is missing (scans) or when a
 * caller asks for pictures of the pages.
 *
 * Rendering goes through unpdf's `renderPageAsImage` (the same pdf.js build
 * and hostile-input options as the text reader, see `pdf-doc.ts`) onto an
 * `@napi-rs/canvas` canvas. `@napi-rs/canvas` is an optional peer with a
 * native binary; unlike every other peer of this module its absence
 * DEGRADES rather than throws — {@link renderPdfPages} returns no images and
 * the note {@link PDF_IMAGES_UNAVAILABLE_NOTE}, so a text-only result still
 * reaches the model.
 *
 * Each page is scaled so its longer side is at most {@link PDF_IMAGE_MAX_SIDE}
 * px (which also bounds the pixel buffer a hostile page size can demand) and
 * encoded as JPEG quality 80 (PNG if JPEG encoding fails). Rendering stops
 * before `maxImages` or `maxImageBytes` would be exceeded, with a note naming
 * the pages not rendered. The signal is checked between pages.
 */

import { describePdfError, pageRange, pdfBaseName, withPdf, type PdfDoc } from './pdf-doc.js';
import { importPeer } from './peer.js';
import { resolveConvertLimits, type ConvertedPart, type ConvertLimits, type ResolvedConvertLimits } from './types.js';

/** Longest side, in pixels, of a rendered page image. */
export const PDF_IMAGE_MAX_SIDE = 1600;

/** JPEG quality (0–1) of rendered page images. */
export const PDF_IMAGE_JPEG_QUALITY = 0.8;

/** The note returned instead of images when `@napi-rs/canvas` is not installed. */
export const PDF_IMAGES_UNAVAILABLE_NOTE = 'page images unavailable: install @napi-rs/canvas';

/** Options for {@link renderPdfPages}. */
export interface RenderPdfPagesOptions {
  /** Attachment file name; images are named `<base>-page-<N>.jpg` (`document-page-<N>.jpg` without one). */
  fileName?: string;
  /** Loads `@napi-rs/canvas`. Defaults to a dynamic `import()`; injectable for tests. */
  canvasImport?: () => Promise<unknown>;
}

/** Rendered page images plus notes on what was not rendered and why. */
export interface RenderedPdfPages {
  images: ConvertedPart[];
  notes: string[];
}

type ImagePart = Extract<ConvertedPart, { type: 'image' }>;

type RenderPageAsImage = (typeof import('unpdf'))['renderPageAsImage'];
type CanvasModule = typeof import('@napi-rs/canvas');

/** A module-not-found error, possibly wrapped (loaders and test mocks put the original in `cause`). */
function isModuleNotFound(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e !== null && typeof e === 'object'; depth++) {
    const code = (e as { code?: unknown }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Load the canvas module, or the note explaining why page images are unavailable. Never throws. */
async function loadCanvas(canvasImport: () => Promise<unknown>): Promise<{ mod: CanvasModule } | { note: string }> {
  try {
    const mod = (await canvasImport()) as CanvasModule | { default?: CanvasModule } | undefined;
    if (mod === undefined || mod === null) throw new Error('the module is empty');
    return { mod: mod as CanvasModule };
  } catch (err) {
    if (isModuleNotFound(err)) return { note: PDF_IMAGES_UNAVAILABLE_NOTE };
    return { note: `page images unavailable: @napi-rs/canvas could not be loaded (${describePdfError(err)})` };
  }
}

/** Group sorted page numbers into `page 3`, `pages 5–7` phrases. */
function ranges(pages: readonly number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    out.push(pageRange(pages[i]!, pages[j]!));
    i = j + 1;
  }
  return out.join(', ');
}

/**
 * Render `pageNumbers` of an already-open document. Shared by
 * {@link renderPdfPages} and `convertPdf`, which opens the document once.
 */
export async function renderPdfDocPages(
  doc: PdfDoc,
  pageNumbers: readonly number[],
  lim: ResolvedConvertLimits,
  signal: AbortSignal | undefined,
  options: RenderPdfPagesOptions = {},
): Promise<RenderedPdfPages> {
  const images: ImagePart[] = [];
  const notes: string[] = [];
  if (pageNumbers.length === 0) return { images, notes };
  signal?.throwIfAborted();

  const canvas = await loadCanvas(options.canvasImport ?? (() => import('@napi-rs/canvas')));
  if ('note' in canvas) return { images, notes: [canvas.note] };
  const canvasImport = async (): Promise<CanvasModule> => canvas.mod;
  const { renderPageAsImage } = (await importPeer('unpdf', () => import('unpdf'))) as { renderPageAsImage: RenderPageAsImage };

  const base = pdfBaseName(options.fileName);
  const count = doc.numPages;
  const wanted = [...new Set(pageNumbers.filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  const valid = wanted.filter((n) => n >= 1 && n <= count);
  const invalid = wanted.filter((n) => n < 1 || n > count);

  let total = 0;
  for (let i = 0; i < valid.length; i++) {
    const n = valid[i]!;
    signal?.throwIfAborted();
    if (images.length >= lim.maxImages) {
      notes.push(`${ranges(valid.slice(i))} not rendered (maxImages is ${lim.maxImages})`);
      break;
    }
    let data: Uint8Array;
    let ext: 'jpg' | 'png' = 'jpg';
    try {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const longer = Math.max(vp.width, vp.height);
      // Floor to 1/1000 so rounding can never push a side past the cap.
      const scale = Number.isFinite(longer) && longer > 0 ? Math.floor((PDF_IMAGE_MAX_SIDE * 1000) / longer) / 1000 : 1;
      try {
        data = await renderPageAsImage(doc, n, { canvasImport, scale, format: 'jpeg', quality: PDF_IMAGE_JPEG_QUALITY });
      } catch {
        data = await renderPageAsImage(doc, n, { canvasImport, scale, format: 'png' });
        ext = 'png';
      }
      page.cleanup();
    } catch (err) {
      notes.push(`page ${n} could not be rendered: ${describePdfError(err)}`);
      continue;
    }
    if (total + data.length > lim.maxImageBytes) {
      notes.push(`${ranges(valid.slice(i))} not rendered (the ${lim.maxImageBytes}-byte image cap was reached)`);
      break;
    }
    total += data.length;
    images.push({ type: 'image', name: `${base}-page-${n}.${ext}`, mimeType: ext === 'jpg' ? 'image/jpeg' : 'image/png', data });
  }
  if (invalid.length > 0) notes.push(`${ranges(invalid)} not rendered (the PDF has ${count} ${count === 1 ? 'page' : 'pages'})`);
  return { images, notes };
}

/**
 * Render the given 1-based `pageNumbers` of a PDF as images (JPEG, longer
 * side ≤ {@link PDF_IMAGE_MAX_SIDE} px), named `<base>-page-<N>.jpg`.
 *
 * Stops before `maxImages` or `maxImageBytes` would be exceeded and notes
 * the pages not rendered; page numbers outside the document are skipped with
 * a note. When `@napi-rs/canvas` cannot be imported it returns no images and
 * a note ({@link PDF_IMAGES_UNAVAILABLE_NOTE}) — it never throws for that.
 * It does throw, as `extractPdfText` does, for an oversized or unreadable
 * PDF, a missing `unpdf`, or an aborted signal.
 */
export async function renderPdfPages(
  bytes: Uint8Array,
  pageNumbers: readonly number[],
  limits?: ConvertLimits,
  signal?: AbortSignal,
  options: RenderPdfPagesOptions = {},
): Promise<RenderedPdfPages> {
  const lim = resolveConvertLimits(limits);
  signal?.throwIfAborted();
  if (pageNumbers.length === 0) return { images: [], notes: [] };
  return withPdf(bytes, lim, signal, (doc) => renderPdfDocPages(doc, pageNumbers, lim, signal, options));
}
