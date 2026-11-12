/**
 * `@chrischall/mcp-utils/convert` — turn an attachment into content a model
 * can read.
 *
 * Hosted MCP clients (claude.ai) render only images inline; every other file
 * `deliverFile` returns is a download link the MODEL cannot open. Mail and
 * chat servers (office-outlook-mcp, microsoft-teams-mcp) need attachments as
 * readable content: PDFs as Markdown or page images, workbooks as CSV, decks
 * as per-slide Markdown plus their pictures.
 *
 * The converters run on optional peers loaded with a dynamic `import()` only
 * when a format is converted (`exceljs` + `fflate` for workbooks, `unpdf` for
 * PDFs, `fflate` + `fast-xml-parser` for decks, `@napi-rs/canvas` for PDF page images — whose absence degrades to a
 * text-only result with a note instead of throwing), so a server
 * that never converts a format need not install its library; this subpath
 * never enters the core barrel. Input is treated as hostile: zip archives are
 * read through a bounded reader (declared AND actual inflated sizes capped),
 * and every cap that bites is reported — a `truncated` part or a note, never
 * a silent cut. Converted text is untrusted third-party data; callers wrap it
 * in their own untrusted-content envelope.
 */

import { McpToolError } from '../errors/index.js';
import { convertPdf } from './pdf.js';
import { convertPptx } from './pptx.js';
import { resolveConvertLimits, type ConvertibleFormat, type ConvertLimits, type ConvertMode, type ConvertResult } from './types.js';
import { convertXlsx } from './xlsx.js';

export * from './types.js';
export { csvField, csvRow, toCsv } from './csv.js';
export { assertZipWithinLimits, openZip, repackZipWithinLimits, type ZipEntryInfo, type ZipReader } from './zip-read.js';
export { cellText, convertXlsx, sheetFileName } from './xlsx.js';
export { convertPdf, extractPdfText, isTextSparse, PDF_SPARSE_CHARS_PER_PAGE, PDF_SPARSE_NOTE, type PdfText } from './pdf.js';
export {
  PDF_IMAGE_JPEG_QUALITY,
  PDF_IMAGE_MAX_SIDE,
  PDF_IMAGES_UNAVAILABLE_NOTE,
  renderPdfPages,
  type RenderedPdfPages,
  type RenderPdfPagesOptions,
} from './pdf-images.js';
export { convertPptx } from './pptx.js';

const MIME_FORMATS: ReadonlyMap<string, ConvertibleFormat> = new Map([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.ms-excel.sheet.macroenabled.12', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
]);

const EXT_FORMATS: ReadonlyMap<string, ConvertibleFormat> = new Map([
  ['pdf', 'pdf'],
  ['xlsx', 'xlsx'],
  ['xlsm', 'xlsx'],
  ['pptx', 'pptx'],
]);

/**
 * Which convertible format an attachment is, from its MIME type (parameters
 * and case ignored) or — only when the MIME type is missing, empty or
 * `application/octet-stream` — its file extension. `undefined` when it is
 * none of PDF, .xlsx/.xlsm or .pptx. A specific, non-convertible MIME type
 * wins over the extension. {@link convertAttachment} also checks the bytes.
 */
export function detectConvertible(fileName: string, mimeType?: string): ConvertibleFormat | undefined {
  const mime = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  if (mime !== '' && mime !== 'application/octet-stream') return MIME_FORMATS.get(mime);
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXT_FORMATS.get(fileName.slice(dot + 1).toLowerCase());
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/** Options for {@link convertAttachment}. */
export interface ConvertAttachmentOptions {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
  /** Default `'auto'`. `'images'` applies to PDFs only; workbooks and decks convert as `'auto'`. */
  mode?: ConvertMode;
  limits?: ConvertLimits;
  signal?: AbortSignal;
}

/**
 * Turn an attachment into model-readable content: a PDF into Markdown and/or
 * page images, a workbook into one CSV per sheet, a deck into per-slide
 * Markdown plus its pictures.
 *
 * Returns `undefined` — not an error — when the attachment is not a
 * convertible format ({@link detectConvertible}) or its bytes do not start
 * with the format's magic (`%PDF-`, or a zip's `PK\x03\x04`). Throws an
 * {@link McpToolError} (kind `'too_large'`) for an input over
 * `limits.maxInputBytes`, and whatever the converter throws (a missing
 * optional peer, a corrupt file, an abort).
 */
export async function convertAttachment(opts: ConvertAttachmentOptions): Promise<ConvertResult | undefined> {
  const { bytes, fileName, mimeType, mode = 'auto', limits, signal } = opts;
  signal?.throwIfAborted();
  const format = detectConvertible(fileName, mimeType);
  if (!format) return undefined;
  if (!startsWith(bytes, format === 'pdf' ? PDF_MAGIC : ZIP_MAGIC)) return undefined;
  const lim = resolveConvertLimits(limits);
  if (bytes.length > lim.maxInputBytes) {
    throw new McpToolError(`The attachment "${fileName}" is ${bytes.length} bytes, over the ${lim.maxInputBytes}-byte input cap.`, {
      kind: 'too_large',
    });
  }
  if (format === 'pdf') return convertPdf(bytes, mode, lim, signal, fileName);
  const result = format === 'xlsx' ? await convertXlsx(bytes, lim, signal) : await convertPptx(bytes, lim, signal, fileName);
  if (mode === 'images') {
    const what = format === 'xlsx' ? 'workbooks' : 'decks';
    result.notes.unshift(`mode 'images' does not apply to ${what}; converted as 'auto'`);
  }
  return result;
}

/** One MCP content block produced by {@link convertedToContent}. */
export type ConvertedContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/**
 * Map a {@link ConvertResult} to MCP tool-result content: each text part as a
 * text block headed `--- <name> (<mimeType>[, truncated]) ---`, each image
 * part as a base64 image block, then — when there are notes — one final text
 * block listing them. The text is untrusted third-party data: wrap it in the
 * server's untrusted-content envelope before returning it.
 */
export function convertedToContent(r: ConvertResult): ConvertedContent[] {
  const out: ConvertedContent[] = r.parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: `--- ${p.name} (${p.mimeType}${p.truncated ? ', truncated' : ''}) ---\n${p.text}` }
      : { type: 'image', data: Buffer.from(p.data).toString('base64'), mimeType: p.mimeType },
  );
  if (r.notes.length > 0) out.push({ type: 'text', text: `Notes:\n${r.notes.map((n) => `- ${n}`).join('\n')}` });
  return out;
}
