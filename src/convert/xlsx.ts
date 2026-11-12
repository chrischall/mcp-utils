/**
 * Excel workbooks (.xlsx / .xlsm) → one CSV per worksheet.
 *
 * A model cannot read a spreadsheet handed back as a download link, but it
 * reads CSV well. Each worksheet becomes a `text/csv` part named
 * `<sheet name>.csv` (file-name-unsafe characters replaced with `_`):
 *
 *  - formula → its cached result; rich text → its concatenated runs;
 *    hyperlink → its text; Date → ISO 8601 (`YYYY-MM-DD` at midnight UTC, else
 *    the full timestamp); error → its `#` code; boolean → `TRUE`/`FALSE`;
 *    empty → `''`;
 *  - trailing empty rows and columns are dropped; interior gaps are kept so
 *    rows and columns still line up with the sheet;
 *  - hidden sheets are included, and noted;
 *  - `maxPages` caps the sheets read, `maxTextBytes` the CSV bytes across all
 *    sheets (cut at a row boundary, `truncated: true`, a note naming the sheet
 *    and the rows kept).
 *
 * exceljs inflates the whole archive without any size guard, so the bytes go
 * through the bounded zip reader first and exceljs is handed a fresh archive
 * rebuilt from the entries it inflated (see `repackZipWithinLimits`).
 *
 * Memory: the repacked archive holds the inflated entries once (up to
 * `maxUnzippedBytes`, 200 MiB by default — entries are inflated straight into
 * it, never also kept as a second copy) and stays alive while exceljs loads
 * it; exceljs then builds the whole workbook model, and every non-empty cell
 * is kept until its sheet is written. So peak heap is that archive plus
 * exceljs's model, both scaling with the inflated XML — a hostile workbook
 * within the cap can still cost several GB. Lower `maxUnzippedBytes` where
 * that matters; the CSV output itself is bounded by `maxTextBytes`.
 */

import type { Workbook, Worksheet } from 'exceljs';
import { McpToolError } from '../errors/index.js';
import { csvRow } from './csv.js';
import { safeFileName } from './file-name.js';
import { importPeer } from './peer.js';
import { resolveConvertLimits, type ConvertLimits, type ConvertResult, type ConvertedPart } from './types.js';
import { repackZipWithinLimits } from './zip-read.js';

/** `<sheet name>.csv`, with `/\:*?"<>|` and control characters replaced by `_`. */
export function sheetFileName(sheetName: string): string {
  return `${safeFileName(sheetName)}.csv`;
}

function isoDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return '';
  const iso = d.toISOString();
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
    ? iso.slice(0, 10)
    : iso;
}

/** One cell value as CSV field text (see the module header for the rules). */
export function cellText(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return isoDate(value);
  if (typeof value !== 'object' || depth > 3) return '';
  const v = value as Record<string, unknown>;
  if (typeof v.error === 'string') return v.error;
  if (Array.isArray(v.richText)) {
    return v.richText.map((run) => (typeof (run as { text?: unknown })?.text === 'string' ? (run as { text: string }).text : '')).join('');
  }
  if ('hyperlink' in v) {
    const t = cellText(v.text, depth + 1);
    return t !== '' ? t : typeof v.hyperlink === 'string' ? v.hyperlink : '';
  }
  if ('formula' in v || 'sharedFormula' in v) return cellText(v.result, depth + 1);
  if ('result' in v) return cellText(v.result, depth + 1);
  if (typeof v.text === 'string') return v.text;
  return '';
}

/**
 * A worksheet's non-empty cells, sparse. Rows are produced lazily by
 * {@link denseRow}: a tiny file can place one cell at XFD1048576, and padding
 * the whole rectangle up front would be ~17 billion fields.
 */
interface SparseSheet {
  byRow: Map<number, string[]>;
  /** Last row holding a non-empty cell (1-based); 0 when the sheet is empty. */
  lastRow: number;
  /** Last column holding a non-empty cell, across all rows. */
  width: number;
}

function sparseSheet(ws: Worksheet, signal?: AbortSignal): SparseSheet {
  const byRow = new Map<number, string[]>();
  let lastRow = 0;
  let width = 0;
  let seen = 0;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (++seen % 1000 === 0) signal?.throwIfAborted();
    const fields: string[] = [];
    let last = 0;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = cellText(cell.value);
      if (t === '') return;
      fields[col - 1] = t;
      if (col > last) last = col;
    });
    if (last === 0) return;
    byRow.set(rowNumber, fields);
    if (rowNumber > lastRow) lastRow = rowNumber;
    if (last > width) width = last;
  });
  return { byRow, lastRow, width };
}

/** Row `r` (1-based) padded to the sheet's width. */
function denseRow(sheet: SparseSheet, r: number): string[] {
  const src = sheet.byRow.get(r);
  const row = new Array<string>(sheet.width);
  for (let i = 0; i < sheet.width; i++) row[i] = src?.[i] ?? '';
  return row;
}

async function loadWorkbook(bytes: Uint8Array): Promise<Workbook> {
  const mod = await importPeer('exceljs', () => import('exceljs'));
  // exceljs is CommonJS: its namespace arrives on `default` under Node ESM.
  const { Workbook: WorkbookCtor } = mod.default ?? mod;
  const wb = new WorkbookCtor();
  try {
    await wb.xlsx.load(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as unknown as ArrayBuffer);
  } catch (err) {
    throw new McpToolError(`Could not read the workbook: ${err instanceof Error ? err.message : String(err)}`, {
      kind: 'unknown',
      cause: err,
    });
  }
  return wb;
}

/**
 * Convert an .xlsx/.xlsm workbook to one CSV part per worksheet. Throws an
 * {@link McpToolError} for an oversized input or archive (kind `'too_large'`),
 * a missing `exceljs`/`fflate`, or bytes that are not a readable workbook.
 */
export async function convertXlsx(bytes: Uint8Array, limits?: ConvertLimits, signal?: AbortSignal): Promise<ConvertResult> {
  signal?.throwIfAborted();
  const lim = resolveConvertLimits(limits);
  if (bytes.length > lim.maxInputBytes) {
    throw new McpToolError(`The workbook is ${bytes.length} bytes, over the ${lim.maxInputBytes}-byte input cap.`, {
      kind: 'too_large',
    });
  }
  // exceljs loads the REPACKED archive: only entries the bounded reader has
  // already inflated and counted, so its own zip parser cannot be steered to
  // anything the guard did not see.
  const { names, bytes: repacked } = await repackZipWithinLimits(bytes, lim, signal);
  // exceljs "loads" any zip as an empty workbook; say what is wrong instead.
  // (It strips one leading '/' from entry names, so '/xl/workbook.xml' counts.)
  if (!names.some((n) => n.replace(/^\//, '') === 'xl/workbook.xml')) {
    throw new McpToolError('Could not read the workbook: the archive has no xl/workbook.xml (not an .xlsx/.xlsm file).', {
      kind: 'unknown',
    });
  }
  signal?.throwIfAborted();
  const wb = await loadWorkbook(repacked);

  const sheets = wb.worksheets;
  const parts: ConvertedPart[] = [];
  const notes: string[] = [];
  const usedNames = new Set<string>();
  let budget = lim.maxTextBytes;

  const read = sheets.slice(0, lim.maxPages);
  const unread = sheets.slice(lim.maxPages);
  for (let i = 0; i < read.length; i++) {
    signal?.throwIfAborted();
    const ws = read[i]!;
    if (budget <= 0) {
      const rest = read.slice(i).map((s) => `"${s.name}"`).join(', ');
      notes.push(`sheet${read.length - i === 1 ? '' : 's'} ${rest} not converted: the ${lim.maxTextBytes}-byte text cap was reached`);
      break;
    }
    if (ws.state === 'hidden' || ws.state === 'veryHidden') notes.push(`sheet "${ws.name}" is hidden (included)`);

    // Rows are built one at a time and the loop stops when the text budget is
    // spent, so the work is bounded by maxTextBytes (every row costs at least
    // its CRLF), not by how far apart the sheet's cells are.
    const sheet = sparseSheet(ws, signal);
    let text = '';
    let kept = 0;
    let truncated = false;
    for (let r = 1; r <= sheet.lastRow; r++) {
      if (r % 1000 === 0) signal?.throwIfAborted();
      const line = csvRow(denseRow(sheet, r));
      const size = Buffer.byteLength(line);
      if (size > budget) {
        truncated = true;
        break;
      }
      text += line;
      budget -= size;
      kept++;
    }
    if (truncated) {
      // Nothing more fits; later sheets are reported by the budget check above.
      const what = kept === 0 ? 'no rows kept' : `kept rows 1–${kept}`;
      notes.push(`sheet "${ws.name}": ${what} of ${sheet.lastRow} (the ${lim.maxTextBytes}-byte text cap was reached)`);
      budget = 0;
    }

    let name = sheetFileName(ws.name);
    for (let n = 2; usedNames.has(name); n++) name = sheetFileName(`${ws.name} (${n})`);
    usedNames.add(name);
    parts.push({ type: 'text', name, mimeType: 'text/csv', text, ...(truncated ? { truncated: true } : {}) });
  }
  if (unread.length > 0) {
    notes.push(
      `${unread.length} sheet${unread.length === 1 ? '' : 's'} not read (maxPages is ${lim.maxPages}): ${unread.map((s) => `"${s.name}"`).join(', ')}`,
    );
  }
  return { format: 'xlsx', parts, notes, count: sheets.length };
}
