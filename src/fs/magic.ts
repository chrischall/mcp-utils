/**
 * Magic-byte (leading signature) detection for the file types the fleet moves
 * around: images (PNG / JPEG / WebP / GIF), ISO-BMFF media (HEIC / HEIF / AVIF
 * / MP4 / MOV / M4A), PDF, zip containers (mscz, mxl, docx, epub…) and
 * Standard MIDI Files.
 *
 * Consolidates gemini's `sniffMimeBytes` (images), musescore's
 * `FORMAT_MAGIC`/`readMagic` (PDF / zip / MIDI — the check that keeps a gated
 * "Forbidden" HTML page from being saved as a `.pdf`), and skylight's
 * upload-guard `SIGNATURES` (images + ISO-BMFF). Pair with `readFileHead` for
 * an on-disk file; 16 bytes is enough for every signature here.
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Whether `buf` starts with the bytes of `sig` (a byte array or latin1 string). */
function startsWith(buf: Uint8Array, sig: readonly number[] | string, offset = 0): boolean {
  const bytes = typeof sig === 'string' ? Array.from(sig, (c) => c.charCodeAt(0)) : sig;
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}

function latin1(buf: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...buf.subarray(start, end));
}

/**
 * Top-level ISO-BMFF box types that can open a file. `ftyp` for anything
 * modern; the rest are legacy QuickTime atoms an old `.mov` may start with.
 */
const BMFF_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

function isBmff(buf: Uint8Array): boolean {
  return buf.length >= 8 && BMFF_BOXES.has(latin1(buf, 4, 8));
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

/** The MIME an `ftyp` major brand names; `undefined` when there is no ftyp box. */
function bmffMime(buf: Uint8Array): string | undefined {
  if (buf.length < 12 || latin1(buf, 4, 8) !== 'ftyp') return undefined;
  const brand = latin1(buf, 8, 12);
  if (HEIC_BRANDS.has(brand)) return 'image/heic';
  if (HEIF_BRANDS.has(brand)) return 'image/heif';
  if (brand === 'avif' || brand === 'avis') return 'image/avif';
  if (brand === 'qt  ') return 'video/quicktime';
  if (brand === 'M4A ') return 'audio/mp4';
  return 'video/mp4';
}

/** Exact (non-ISO-BMFF) signatures, in detection order. */
const SIGNATURES: ReadonlyArray<readonly [mime: string, test: (b: Uint8Array) => boolean]> = [
  ['image/png', (b) => startsWith(b, PNG_SIG)],
  ['image/jpeg', (b) => startsWith(b, [0xff, 0xd8, 0xff])],
  ['image/webp', (b) => startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8)],
  ['image/gif', (b) => startsWith(b, 'GIF8')],
  ['application/pdf', (b) => startsWith(b, '%PDF-')],
  // Local file header; empty archive (end-of-central-directory first); spanned.
  ['application/zip', (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]) || startsWith(b, [0x50, 0x4b, 0x07, 0x08])],
  ['audio/midi', (b) => startsWith(b, 'MThd')],
];

/** ISO-BMFF MIME types — matched as a family by {@link bytesMatchMime}. */
const BMFF_MIMES = new Set(['image/heic', 'image/heif', 'image/avif', 'video/mp4', 'video/quicktime', 'audio/mp4']);

/** Common aliases normalized before matching. */
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'audio/x-midi': 'audio/midi',
  'audio/mid': 'audio/midi',
  'application/x-zip-compressed': 'application/zip',
  'application/x-pdf': 'application/pdf',
};

/**
 * Magic-byte MIME sniff. Returns the detected type — `image/png`,
 * `image/jpeg`, `image/webp`, `image/gif`, `application/pdf`,
 * `application/zip`, `audio/midi`, or (from an ISO-BMFF `ftyp` major brand)
 * `image/heic`, `image/heif`, `image/avif`, `video/quicktime`, `audio/mp4`,
 * `video/mp4` — or `undefined` for anything else (including a legacy
 * QuickTime head with no `ftyp`, whose type it cannot name). Callers decide
 * their own default. Needs at most the first 16 bytes.
 */
export function sniffMimeBytes(bytes: Uint8Array): string | undefined {
  for (const [mime, test] of SIGNATURES) if (test(bytes)) return mime;
  return bmffMime(bytes);
}

/**
 * Whether `bytes` (a file's head) start like `mime` claims — the "is this
 * renamed secret really a .png" check. Fails closed: a MIME type with no known
 * signature returns `false`, never a silent pass.
 *
 * The ISO-BMFF family (heic / heif / avif / mp4 / quicktime / m4a) is matched
 * loosely — any leading BMFF box is accepted for any of them — because brands
 * vary between encoders and an old `.mov` has no `ftyp` at all; a credential
 * or text file still never passes. Aliases like `image/jpg` are normalized and
 * the comparison is case-insensitive.
 */
export function bytesMatchMime(bytes: Uint8Array, mime: string): boolean {
  const lower = mime.toLowerCase();
  const want = MIME_ALIASES[lower] ?? lower;
  if (BMFF_MIMES.has(want)) return isBmff(bytes);
  const sig = SIGNATURES.find(([m]) => m === want);
  return sig !== undefined && sig[1](bytes);
}
