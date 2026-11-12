/**
 * Opening a PDF safely, shared by the text reader (`pdf.ts`) and the page
 * renderer (`pdf-images.ts`), so both run pdf.js with the same hostile-input
 * options and report a bad PDF the same way.
 *
 * The pdf.js build unpdf bundles has no eval / `new Function` path at all
 * (the old `isEvalSupported` switch is gone with it); the document is opened
 * with `disableFontFace: true` (no font loading), `useSystemFonts: false`,
 * `enableXfa: false` and nothing to fetch from (the bytes are handed over
 * whole, range/stream/auto-fetch off).
 */

import { McpToolError } from '../errors/index.js';
import { importPeer } from './peer.js';
import type { ResolvedConvertLimits } from './types.js';

/** An open pdf.js document, as unpdf's `getDocumentProxy` returns it. */
export type PdfDoc = Awaited<ReturnType<(typeof import('unpdf'))['getDocumentProxy']>>;

/** One line, no stack, bounded: pdf.js messages can quote document bytes. */
export function describePdfError(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'PasswordException') return 'the PDF is password-protected';
  const msg = err instanceof Error ? err.message : String(err);
  return (msg.split('\n')[0] ?? '').slice(0, 200) || 'unknown error';
}

/**
 * Open `bytes` as a PDF, run `use` on the document and always destroy it
 * afterwards. Throws an {@link McpToolError} for an input over
 * `maxInputBytes` (kind `'too_large'`), a missing `unpdf`, or bytes that are
 * not a readable PDF (`Could not read the PDF: …`).
 */
export async function withPdf<T>(
  bytes: Uint8Array,
  lim: ResolvedConvertLimits,
  signal: AbortSignal | undefined,
  use: (doc: PdfDoc) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (bytes.length > lim.maxInputBytes) {
    throw new McpToolError(`The PDF is ${bytes.length} bytes, over the ${lim.maxInputBytes}-byte input cap.`, { kind: 'too_large' });
  }
  const { getDocumentProxy } = await importPeer('unpdf', () => import('unpdf'));
  signal?.throwIfAborted();
  let doc: PdfDoc;
  try {
    // pdf.js may transfer (detach) the buffer it is given; hand it a copy.
    doc = await getDocumentProxy(bytes.slice(), {
      disableFontFace: true,
      enableXfa: false,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      verbosity: 0,
    });
  } catch (err) {
    throw new McpToolError(`Could not read the PDF: ${describePdfError(err)}`, { kind: 'unknown', cause: err });
  }
  try {
    return await use(doc);
  } finally {
    await doc.loadingTask.destroy().catch(() => undefined);
  }
}

/** The base of an attachment file name: leaf only, `.pdf` dropped, unsafe characters `_`; `document` when empty. */
export function pdfBaseName(fileName: string | undefined): string {
  const leaf = (fileName ?? '').split(/[/\\]/).pop() ?? '';
  const base = leaf.replace(/\.pdf$/i, '').replace(/[:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  return base === '' ? 'document' : base;
}

/** `page 3` or `pages 3–5`. */
export function pageRange(from: number, to: number, noun = 'page'): string {
  return from === to ? `${noun} ${from}` : `${noun}s ${from}–${to}`;
}
