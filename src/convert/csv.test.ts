import { describe, expect, it } from 'vitest';
import { csvField, csvRow, toCsv } from './csv.js';

describe('csvField', () => {
  it('leaves plain fields bare', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField('')).toBe('');
    expect(csvField('a b')).toBe('a b');
  });

  it('quotes fields containing a comma, quote, CR or LF and doubles inner quotes', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('cr\rhere')).toBe('"cr\rhere"');
  });

  it('quotes fields with leading or trailing whitespace', () => {
    expect(csvField(' lead')).toBe('" lead"');
    expect(csvField('trail ')).toBe('"trail "');
    expect(csvField('\ttab')).toBe('"\ttab"');
  });
});

describe('csvRow / toCsv', () => {
  it('joins fields with commas and ends every row with CRLF', () => {
    expect(csvRow(['a', 'b,c', ''])).toBe('a,"b,c",\r\n');
    expect(toCsv([['x', 'y'], ['1', '2']])).toBe('x,y\r\n1,2\r\n');
  });

  it('renders no rows as an empty string', () => {
    expect(toCsv([])).toBe('');
  });
});
