import { describe, expect, it } from 'vitest';
import { attachmentBaseName, safeFileName } from './file-name.js';

describe('safeFileName', () => {
  it('replaces path separators, characters Windows forbids and control characters with _', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j\u0000k\u001fl\u007fm')).toBe('a_b_c_d_e_f_g_h_i_j_k_l_m');
  });

  it('leaves other characters, unicode and edge spaces alone', () => {
    expect(safeFileName(' Données € (2).v1 ')).toBe(' Données € (2).v1 ');
  });
});

describe('attachmentBaseName', () => {
  const ext = /\.pdf$/i;
  it('keeps the leaf of a path, drops the extension and makes the rest safe', () => {
    expect(attachmentBaseName('C:\\mail\\in/Q3: "final".PDF', ext, 'document')).toBe('Q3_ _final_');
  });

  it('trims, and falls back when nothing is left', () => {
    expect(attachmentBaseName('  Report  .pdf', ext, 'document')).toBe('Report');
    expect(attachmentBaseName('.pdf', ext, 'document')).toBe('document');
    expect(attachmentBaseName('dir/', ext, 'document')).toBe('document');
    expect(attachmentBaseName(undefined, ext, 'presentation')).toBe('presentation');
  });

  it('only drops the extension it was given', () => {
    expect(attachmentBaseName('notes.txt', ext, 'document')).toBe('notes.txt');
  });
});
