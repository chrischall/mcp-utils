import { describe, expect, it } from 'vitest';

import { bytesMatchMime, sniffMimeBytes } from './index.js';

/** An ISO-BMFF head: a box size, the box type at offset 4, then (for ftyp) the major brand. */
function bmff(box: string, brand = ''): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(box, 'latin1'), Buffer.from(brand.padEnd(4, ' '), 'latin1')]);
}

describe('sniffMimeBytes — document / archive / audio signatures', () => {
  it('detects a PDF by its %PDF- header', () => {
    expect(sniffMimeBytes(Buffer.from('%PDF-1.7\n%âãÏÓ'))).toBe('application/pdf');
  });

  it('does not call a bare "%PDF" (no version dash) a PDF', () => {
    expect(sniffMimeBytes(Buffer.from('%PDF'))).toBeUndefined();
  });

  it('detects a zip local-file header (PK\\x03\\x04) — mscz, mxl, docx, epub', () => {
    expect(sniffMimeBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe('application/zip');
  });

  it('detects an empty zip (end-of-central-directory first) and a spanned zip', () => {
    expect(sniffMimeBytes(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0]))).toBe('application/zip');
    expect(sniffMimeBytes(Buffer.from([0x50, 0x4b, 0x07, 0x08, 0, 0]))).toBe('application/zip');
  });

  it('does not call a bare "PK" (an HTML page that happens to start PK…) a zip', () => {
    expect(sniffMimeBytes(Buffer.from('PK'))).toBeUndefined();
    expect(sniffMimeBytes(Buffer.from('PKZIP is a…'))).toBeUndefined();
  });

  it('detects a Standard MIDI File by its MThd chunk', () => {
    expect(sniffMimeBytes(Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]))).toBe('audio/midi');
  });

  it('refuses the gated-download HTML page musescore guards against', () => {
    expect(sniffMimeBytes(Buffer.from('<!DOCTYPE html><html>Forbidden'))).toBeUndefined();
  });
});

describe('sniffMimeBytes — ISO-BMFF (HEIC / AVIF / MP4 / MOV / M4A)', () => {
  it('maps HEIC/HEIF major brands to image/heic or image/heif', () => {
    expect(sniffMimeBytes(bmff('ftyp', 'heic'))).toBe('image/heic');
    expect(sniffMimeBytes(bmff('ftyp', 'heix'))).toBe('image/heic');
    expect(sniffMimeBytes(bmff('ftyp', 'mif1'))).toBe('image/heif');
  });

  it('maps avif, QuickTime and M4A brands', () => {
    expect(sniffMimeBytes(bmff('ftyp', 'avif'))).toBe('image/avif');
    expect(sniffMimeBytes(bmff('ftyp', 'qt'))).toBe('video/quicktime');
    expect(sniffMimeBytes(bmff('ftyp', 'M4A'))).toBe('audio/mp4');
  });

  it('calls any other ftyp brand video/mp4', () => {
    expect(sniffMimeBytes(bmff('ftyp', 'isom'))).toBe('video/mp4');
    expect(sniffMimeBytes(bmff('ftyp', 'mp42'))).toBe('video/mp4');
  });

  it('leaves a legacy QuickTime head (no ftyp) undecided — it names no type', () => {
    expect(sniffMimeBytes(bmff('moov'))).toBeUndefined();
  });

  it('needs the whole 12-byte ftyp head before naming a type', () => {
    expect(sniffMimeBytes(bmff('ftyp', 'heic').subarray(0, 10))).toBeUndefined();
  });
});

describe('bytesMatchMime', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('accepts bytes that start like the claimed type', () => {
    expect(bytesMatchMime(png, 'image/png')).toBe(true);
    expect(bytesMatchMime(Buffer.from([0xff, 0xd8, 0xff, 0xdb]), 'image/jpeg')).toBe(true);
    expect(bytesMatchMime(Buffer.from('%PDF-1.4'), 'application/pdf')).toBe(true);
    expect(bytesMatchMime(Buffer.from('MThd\0\0\0\x06'), 'audio/midi')).toBe(true);
    expect(bytesMatchMime(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/zip')).toBe(true);
  });

  it('refuses bytes of a different type (a renamed secret)', () => {
    expect(bytesMatchMime(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----'), 'image/png')).toBe(false);
    expect(bytesMatchMime(png, 'image/jpeg')).toBe(false);
    expect(bytesMatchMime(Buffer.from('%PDF-1.4'), 'application/zip')).toBe(false);
  });

  it('treats the ISO-BMFF family loosely — any leading box type is accepted for heic/mp4/mov', () => {
    // Brands vary wildly between encoders (an iPhone .mov is `qt  `, an MP4 is
    // `isom`/`mp42`/…, old QuickTime has no ftyp at all), so the family check
    // is "is this ISO-BMFF", which a credential file still never passes.
    expect(bytesMatchMime(bmff('ftyp', 'isom'), 'video/quicktime')).toBe(true);
    expect(bytesMatchMime(bmff('moov'), 'video/quicktime')).toBe(true);
    expect(bytesMatchMime(bmff('ftyp', 'mif1'), 'image/heic')).toBe(true);
    expect(bytesMatchMime(bmff('ftyp', 'heic'), 'video/mp4')).toBe(true);
    expect(bytesMatchMime(Buffer.from('#!/bin/sh\necho hi\n'), 'video/mp4')).toBe(false);
  });

  it('accepts the image/jpg alias and is case-insensitive about the MIME', () => {
    expect(bytesMatchMime(Buffer.from([0xff, 0xd8, 0xff, 0xe1]), 'image/jpg')).toBe(true);
    expect(bytesMatchMime(png, 'IMAGE/PNG')).toBe(true);
  });

  it('fails closed for a MIME type it has no signature for', () => {
    expect(bytesMatchMime(Buffer.from('hello'), 'text/plain')).toBe(false);
    expect(bytesMatchMime(png, 'application/octet-stream')).toBe(false);
  });

  it('fails closed on a short head', () => {
    expect(bytesMatchMime(png.subarray(0, 4), 'image/png')).toBe(false);
    expect(bytesMatchMime(Buffer.alloc(0), 'image/jpeg')).toBe(false);
  });
});
