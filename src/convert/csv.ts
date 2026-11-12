/**
 * RFC 4180 CSV writer for converted spreadsheets.
 *
 * Fields containing `,` `"` CR or LF — or with leading/trailing whitespace,
 * which many readers would otherwise trim — are quoted, inner quotes doubled.
 * Every row ends with CRLF.
 */

const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** One CSV field, quoted when RFC 4180 (or whitespace preservation) requires it. */
export function csvField(value: string): string {
  return NEEDS_QUOTES.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One CSV row, including its CRLF terminator. */
export function csvRow(fields: readonly string[]): string {
  return `${fields.map(csvField).join(',')}\r\n`;
}

/** A whole CSV document; no rows → `''`. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map(csvRow).join('');
}
