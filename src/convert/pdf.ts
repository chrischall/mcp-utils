/**
 * PDF → Markdown, from the PDF's text layer.
 *
 * A model cannot open a PDF handed back as a download link, but it reads the
 * text well. {@link extractPdfText} reads each page's text items through
 * `unpdf` (a serverless pdf.js build, an optional peer) and joins them into
 * lines by their `hasEOL` flag and y-position, leaving a blank line where the
 * vertical gap is paragraph-sized and collapsing runs of spaces.
 * {@link convertPdf} turns that into one `text/markdown` part, `## Page N`
 * per page, and — for a scan in mode `'auto'`, or always in mode `'images'`
 * — page images rendered by `pdf-images.ts`.
 *
 * Hostile input: the document is opened by `pdf-doc.ts` (no eval, no font
 * loading, no XFA, nothing to fetch); the signal is checked between pages.
 * Every cap that bites is reported: `maxPages` with a "pages X–Y not read" note,
 * `maxTextBytes` with a cut at a page or line boundary, `truncated: true` and
 * a note. A PDF whose text layer is sparse (see {@link isTextSparse}) is
 * noted as likely scanned.
 */

import { McpToolError } from '../errors/index.js';
import { describePdfError, pageRange, pdfBaseName, withPdf, type PdfDoc } from './pdf-doc.js';
import { renderPdfDocPages } from './pdf-images.js';
import {
  resolveConvertLimits,
  type ConvertedPart,
  type ConvertLimits,
  type ConvertMode,
  type ConvertResult,
  type ResolvedConvertLimits,
} from './types.js';

/** Average non-whitespace characters per page below which a PDF's text layer counts as sparse (likely scanned). */
export const PDF_SPARSE_CHARS_PER_PAGE = 80;

/** The note {@link convertPdf} adds when {@link isTextSparse} holds. */
export const PDF_SPARSE_NOTE = 'this PDF has little or no text layer (likely scanned)';

/**
 * True when `pages` average fewer than {@link PDF_SPARSE_CHARS_PER_PAGE}
 * non-whitespace characters per page (or there are no pages): the PDF is
 * probably scanned images, and page images will read better than its text.
 */
export function isTextSparse(pages: readonly string[]): boolean {
  if (pages.length === 0) return true;
  let chars = 0;
  for (const p of pages) chars += p.replace(/\s+/g, '').length;
  return chars / pages.length < PDF_SPARSE_CHARS_PER_PAGE;
}

/** The text a PDF yielded: one string per page read, plus the page count of the whole document. */
export interface PdfText {
  /** Text of pages 1..min(pageCount, maxPages), in order. */
  pages: string[];
  /** Pages in the document (including any not read). */
  pageCount: number;
}

/** The subset of a pdf.js text item this module reads. */
interface TextItemLike {
  str?: unknown;
  hasEOL?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
}

/**
 * Join one page's text items into lines. A new line starts after an item
 * with `hasEOL` or when the baseline moves; a vertical gap of more than 1.5×
 * the line height leaves a blank line (a paragraph break). Same-line items
 * separated by a visible gap get a space. Runs of spaces collapse to one.
 */
function joinItems(items: readonly TextItemLike[]): string {
  const lines: string[] = [];
  let line = '';
  let lastY: number | undefined;
  let lastEndX: number | undefined;
  let lastHeight = 0;
  let eol = false;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const t = Array.isArray(it.transform) ? (it.transform as unknown[]) : [];
    const x = typeof t[4] === 'number' ? t[4] : undefined;
    const y = typeof t[5] === 'number' ? t[5] : undefined;
    const h = typeof it.height === 'number' && it.height > 0 ? it.height : lastHeight;
    const w = typeof it.width === 'number' ? it.width : 0;
    if (it.str === '' && it.hasEOL !== true) continue;
    const moved = y !== undefined && lastY !== undefined && Math.abs(y - lastY) > Math.max(h, lastHeight, 1) * 0.5;
    if ((eol || moved) && (line !== '' || lines.length > 0)) {
      lines.push(line);
      line = '';
      const gap = y !== undefined && lastY !== undefined ? Math.abs(lastY - y) : 0;
      const lh = Math.max(lastHeight, h, 1);
      if (gap > lh * 1.5 * 1.2) lines.push('');
      lastEndX = undefined;
    } else if (line !== '' && x !== undefined && lastEndX !== undefined && x - lastEndX > Math.max(h, 1) * 0.2 && !/\s$/.test(line) && !/^\s/.test(it.str)) {
      line += ' ';
    }
    line += it.str;
    if (y !== undefined && it.str !== '') lastY = y;
    if (x !== undefined) lastEndX = x + w;
    if (h > 0) lastHeight = h;
    eol = it.hasEOL === true;
  }
  if (line !== '') lines.push(line);
  return lines
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Read the text of pages 1..min(pageCount, maxPages) of an open document. */
async function readPages(doc: PdfDoc, lim: ResolvedConvertLimits, signal?: AbortSignal): Promise<PdfText> {
  const pageCount = doc.numPages;
  const pages: string[] = [];
  const last = Math.min(pageCount, lim.maxPages);
  for (let n = 1; n <= last; n++) {
    signal?.throwIfAborted();
    try {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(joinItems(content.items as TextItemLike[]));
      page.cleanup();
    } catch (err) {
      throw new McpToolError(`Could not read the PDF: page ${n}: ${describePdfError(err)}`, { kind: 'unknown', cause: err });
    }
  }
  return { pages, pageCount };
}

/**
 * Read a PDF's text layer: one string per page for the first `maxPages`
 * pages, and the document's page count. Throws an {@link McpToolError} for an
 * input over `maxInputBytes` (kind `'too_large'`), a missing `unpdf`, or bytes
 * that are not a readable PDF (`Could not read the PDF: …`, one line, no
 * stack).
 */
export async function extractPdfText(bytes: Uint8Array, limits?: ConvertLimits, signal?: AbortSignal): Promise<PdfText> {
  const lim = resolveConvertLimits(limits);
  return withPdf(bytes, lim, signal, (doc) => readPages(doc, lim, signal));
}

/** The text layer as one `text/markdown` part, honouring `maxTextBytes`, plus notes on what was cut. */
function markdownPart(
  { pages, pageCount }: PdfText,
  lim: ResolvedConvertLimits,
  fileName: string | undefined,
): { part: ConvertedPart; notes: string[] } {
  const notes: string[] = [];
  let text = '';
  let budget = lim.maxTextBytes;
  let truncated = false;
  for (let i = 0; i < pages.length; i++) {
    const n = i + 1;
    const heading = `## Page ${n}\n`;
    const body = pages[i]!;
    const block = body === '' ? heading : `${heading}\n${body}\n`;
    const sep = i === 0 ? '' : '\n';
    const size = Buffer.byteLength(sep + block);
    if (size <= budget) {
      text += sep + block;
      budget -= size;
      continue;
    }
    truncated = true;
    // Keep whole lines of this page while they fit (heading first).
    const headSize = Buffer.byteLength(`${sep}${heading}\n`);
    const lines = body.split('\n');
    let kept = 0;
    if (body !== '' && headSize < budget) {
      let rest = budget - headSize;
      let chunk = '';
      for (const l of lines) {
        const s = Buffer.byteLength(`${l}\n`);
        if (s > rest) break;
        chunk += `${l}\n`;
        rest -= s;
        kept++;
      }
      if (kept > 0) {
        text += `${sep}${heading}\n${chunk}`;
        notes.push(`page ${n}: kept lines 1–${kept} of ${lines.length} (the ${lim.maxTextBytes}-byte text cap was reached)`);
      }
    }
    const firstOut = kept > 0 ? n + 1 : n;
    if (firstOut <= pages.length) {
      notes.push(`${pageRange(firstOut, pages.length)} not included (the ${lim.maxTextBytes}-byte text cap was reached)`);
    }
    break;
  }
  if (pageCount > pages.length) notes.push(`${pageRange(pages.length + 1, pageCount)} not read (maxPages is ${lim.maxPages})`);
  if (isTextSparse(pages)) notes.push(PDF_SPARSE_NOTE);
  return {
    part: { type: 'text', name: `${pdfBaseName(fileName)}.md`, mimeType: 'text/markdown', text, ...(truncated ? { truncated: true } : {}) },
    notes,
  };
}

/** 1..n */
function firstPages(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => i + 1);
}

/**
 * Convert a PDF to model-readable parts, named after `fileName`
 * (`document` without one).
 *
 * - `'text'`: one `text/markdown` part, `## Page N` then the page's text
 *   (`<base>.md`). A sparse text layer (see {@link isTextSparse}) adds the
 *   note {@link PDF_SPARSE_NOTE}.
 * - `'auto'`: the same, and when the text layer is sparse (a scan) ALSO
 *   images of the first pages read (`<base>-page-<N>.jpg`, up to
 *   `maxImages` / `maxImageBytes`).
 * - `'images'`: images of pages 1..`maxImages` only, no text part, with a
 *   note of the page count. If no page could be rendered (e.g.
 *   `@napi-rs/canvas` is not installed) it falls back to the text layer,
 *   with notes saying so.
 *
 * `maxPages` caps the pages read or rendered (note: "pages X–Y not read" /
 * "not rendered"), `maxTextBytes` the markdown (cut at a page or line
 * boundary, `truncated`, notes naming what was kept). A missing canvas never
 * throws; otherwise throws as {@link extractPdfText} does.
 */
export async function convertPdf(
  bytes: Uint8Array,
  mode: ConvertMode = 'auto',
  limits?: ConvertLimits,
  signal?: AbortSignal,
  fileName?: string,
): Promise<ConvertResult> {
  const lim = resolveConvertLimits(limits);
  return withPdf(bytes, lim, signal, async (doc) => {
    const pageCount = doc.numPages;

    if (mode === 'images') {
      const renderable = Math.min(pageCount, lim.maxPages);
      const rendered = await renderPdfDocPages(doc, firstPages(renderable), lim, signal, { fileName });
      if (rendered.images.length > 0 || pageCount === 0) {
        const notes = [`the PDF has ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}; returned page images only`, ...rendered.notes];
        if (pageCount > renderable) notes.push(`${pageRange(renderable + 1, pageCount)} not rendered (maxPages is ${lim.maxPages})`);
        return { format: 'pdf', parts: rendered.images, notes, count: pageCount };
      }
      const { part, notes } = markdownPart(await readPages(doc, lim, signal), lim, fileName);
      return {
        format: 'pdf',
        parts: [part],
        notes: [...rendered.notes, 'returned the text layer instead of page images', ...notes],
        count: pageCount,
      };
    }

    const text = await readPages(doc, lim, signal);
    const { part, notes } = markdownPart(text, lim, fileName);
    const parts: ConvertedPart[] = [part];
    if (mode === 'auto' && isTextSparse(text.pages)) {
      const rendered = await renderPdfDocPages(doc, firstPages(text.pages.length), lim, signal, { fileName });
      parts.push(...rendered.images);
      notes.push(...rendered.notes);
    }
    return { format: 'pdf', parts, notes, count: pageCount };
  });
}
