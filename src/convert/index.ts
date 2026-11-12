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
