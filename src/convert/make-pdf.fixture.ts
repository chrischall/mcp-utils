/**
 * Test-only: build a minimal valid PDF in memory, so the PDF tests need no
 * binary fixtures checked in. Excluded from the build (`*.fixture.ts`).
 *
 * Each entry of `pagesText` is one page; `\n` starts a new line 14 pt lower,
 * and a blank line (`\n\n`) leaves a paragraph-sized gap. An empty string
 * makes a page with no text layer at all (a "scanned" page).
 */

function escapePdfString(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

function pageStream(text: string): string {
  if (text === '') return '';
  const ops: string[] = ['BT', '/F1 12 Tf', '72 720 Td'];
  let gap = 0;
  let first = true;
  for (const line of text.split('\n')) {
    if (line === '') {
      gap += 14;
      continue;
    }
    if (!first) ops.push(`0 -${14 + gap} Td`);
    ops.push(`(${escapePdfString(line)}) Tj`);
    first = false;
    gap = 0;
  }
  ops.push('ET');
  return ops.join('\n');
}

/** A PDF with one page per entry of `pagesText` (Helvetica 12 pt, Latin-1 text). */
export function makePdf(pagesText: string[]): Uint8Array {
  const objects: string[] = [];
  const n = pagesText.length;
  // 1: catalog, 2: pages, 3: font, then per page: page object + content stream.
  const pageObj = (i: number) => 4 + i * 2;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pagesText.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${n} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pagesText.forEach((t, i) => {
    const stream = pageStream(t);
    objects[pageObj(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`;
    objects[pageObj(i) + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
