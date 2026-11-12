/**
 * File names for converted parts, shared by every converter.
 *
 * A part's name is shown to the model and may be saved to disk by a caller,
 * and it is built from untrusted text — an attachment's file name, a sheet
 * name. One sanitiser keeps the PDF, workbook and deck converters naming
 * parts the same way.
 */

/** `name` with `/\:*?"<>|` and control characters replaced by `_`; nothing else changes. */
export function safeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '_');
}

/**
 * The base of an attachment file name: its leaf only (after the last `/` or
 * `\`), `ext` removed, made safe by {@link safeFileName} and trimmed;
 * `fallback` when nothing is left (or there is no file name).
 */
export function attachmentBaseName(fileName: string | undefined, ext: RegExp, fallback: string): string {
  const leaf = (fileName ?? '').split(/[/\\]/).pop() ?? '';
  const base = safeFileName(leaf.replace(ext, '')).trim();
  return base === '' ? fallback : base;
}
