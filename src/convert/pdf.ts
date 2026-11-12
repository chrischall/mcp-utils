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
 * `maxTextBytes` with a cut at a page or line boundary (inside the line, at a
 * character boundary, when a page's first line alone is over what is left),
 * `truncated: true` and notes. In `convertPdf`, once the pages read already
 * hold more text than `maxTextBytes`, later pages are still read — every page
 * counts toward the scan check — but their text is not kept
 * (`extractPdfText` returns every page up to `maxPages`). A PDF whose text layer is sparse
 * (see {@link isTextSparse}) is noted as likely scanned.
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
  let chars = 0;
  for (const p of pages) chars += visibleChars(p);
  return sparse(chars, pages.length);
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
 * Join one page's pdf.js text items into lines. A new line starts after an
 * item with `hasEOL` or when the baseline moves; a vertical gap of more than
 * 1.5× the line height leaves a blank line (a paragraph break). Same-line
 * items separated by a visible gap get a space. Runs of spaces collapse to
 * one. Internal to the converter; exported for its tests.
 */
export function joinTextItems(items: readonly TextItemLike[]): string {
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
    if (eol || moved) {
      // An empty end-of-line item leaves `line` empty: it ends no line of its
      // own, so pushing it would add a spurious blank line.
      if (line !== '') lines.push(line);
      line = '';
      const gap = y !== undefined && lastY !== undefined ? Math.abs(lastY - y) : 0;
      const lh = Math.max(lastHeight, h, 1);
      if (gap > lh * 1.5 * 1.2 && lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
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

/** Non-whitespace characters in `text` — what {@link isTextSparse} measures. */
function visibleChars(text: string): number {
  return text.replace(/\s+/g, '').length;
}

/** {@link isTextSparse} over pages already reduced to their {@link visibleChars} total. */
function sparse(chars: number, pages: number): boolean {
  return pages === 0 || chars / pages < PDF_SPARSE_CHARS_PER_PAGE;
}

/** What {@link readPages} found: the text it kept, and enough about the rest for the notes. */
interface PageScan extends PdfText {
  /** Pages read: 1..min(pageCount, maxPages). `pages` may hold fewer (see {@link readPages}). */
  read: number;
  /** {@link isTextSparse} over every page read, kept or not. */
  sparse: boolean;
}

/**
 * Read pages 1..min(pageCount, maxPages) of an open document. With
 * `keepBytes`, page text is kept only until the pages kept hold more than
 * `keepBytes` UTF-8 bytes: no later page can make the cut (its Markdown costs
 * more than its text), so later pages are read for the scan check only.
 */
async function readPages(doc: PdfDoc, lim: ResolvedConvertLimits, signal?: AbortSignal, keepBytes = Infinity): Promise<PageScan> {
  const pageCount = doc.numPages;
  const pages: string[] = [];
  const read = Math.min(pageCount, lim.maxPages);
  let kept = 0;
  let chars = 0;
  for (let n = 1; n <= read; n++) {
    signal?.throwIfAborted();
    let text: string;
    try {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      text = joinTextItems(content.items as TextItemLike[]);
      page.cleanup();
    } catch (err) {
      throw new McpToolError(`Could not read the PDF: page ${n}: ${describePdfError(err)}`, { kind: 'unknown', cause: err });
    }
    chars += visibleChars(text);
    if (kept <= keepBytes) {
      pages.push(text);
      kept += Buffer.byteLength(text);
    }
  }
  return { pages, pageCount, read, sparse: sparse(chars, read) };
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
  return withPdf(bytes, lim, signal, async (doc) => {
    const { pages, pageCount } = await readPages(doc, lim, signal);
    return { pages, pageCount };
  });
}

/** The longest prefix of `line` within `maxBytes` UTF-8 bytes, never splitting a character. */
function cutAtUtf8Boundary(line: string, maxBytes: number): string {
  const buf = Buffer.from(line);
  if (buf.length <= maxBytes) return line;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // back off a continuation byte
  return buf.subarray(0, end).toString();
}

/**
 * The text layer as one `text/markdown` part, honouring `maxTextBytes`, plus
 * notes on what was cut. The page the cap lands in keeps its whole lines that
 * fit; when not even its first line fits, that line is cut by characters.
 */
function markdownPart(
  { pages, pageCount, read, sparse: isSparse }: PageScan,
  lim: ResolvedConvertLimits,
  fileName: string | undefined,
): { part: ConvertedPart; notes: string[] } {
  const notes: string[] = [];
  const cap = `the ${lim.maxTextBytes}-byte text cap was reached`;
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
        notes.push(`page ${n}: kept lines 1–${kept} of ${lines.length} (${cap})`);
      } else {
        // The first line alone is over the budget: keep what fits of it (and its newline).
        const part = cutAtUtf8Boundary(lines[0]!, rest - 1);
        if (part !== '') {
          text += `${sep}${heading}\n${part}\n`;
          kept = 1;
          notes.push(`page ${n}: kept the first ${[...part].length} characters of line 1 of ${lines.length} (${cap})`);
        }
      }
    }
    const firstOut = kept > 0 ? n + 1 : n;
    if (firstOut <= read) notes.push(`${pageRange(firstOut, read)} not included (${cap})`);
    break;
  }
  if (pageCount > read) notes.push(`${pageRange(read + 1, pageCount)} not read (maxPages is ${lim.maxPages})`);
  if (isSparse) notes.push(PDF_SPARSE_NOTE);
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
 * boundary — or by characters when a page's first line alone does not fit —
 * `truncated`, notes naming what was kept and the pages not included). A
 * missing canvas never throws; otherwise throws as {@link extractPdfText} does.
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
      const { part, notes } = markdownPart(await readPages(doc, lim, signal, lim.maxTextBytes), lim, fileName);
      return {
        format: 'pdf',
        parts: [part],
        notes: [...rendered.notes, 'returned the text layer instead of page images', ...notes],
        count: pageCount,
      };
    }

    const scan = await readPages(doc, lim, signal, lim.maxTextBytes);
    const { part, notes } = markdownPart(scan, lim, fileName);
    const parts: ConvertedPart[] = [part];
    if (mode === 'auto' && scan.sparse) {
      const rendered = await renderPdfDocPages(doc, firstPages(scan.read), lim, signal, { fileName });
      parts.push(...rendered.images);
      notes.push(...rendered.notes);
    }
    return { format: 'pdf', parts, notes, count: pageCount };
  });
}
