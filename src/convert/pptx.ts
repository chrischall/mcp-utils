/**
 * PowerPoint decks (.pptx) → per-slide Markdown plus the pictures embedded in
 * each slide.
 *
 * A model cannot open a deck handed back as a download link. There is no true
 * slide rendering here (the hosted runner has no LibreOffice), so a deck is
 * read structurally instead:
 *
 *  - slide order comes from `ppt/presentation.xml`'s `p:sldIdLst` through
 *    `ppt/_rels/presentation.xml.rels` — never from file names, where
 *    `slide10` sorts before `slide2`;
 *  - each slide is `## Slide N: <title>` (the `title` / `ctrTitle`
 *    placeholder; no suffix without one), `(hidden)` when `show="0"`, then
 *    every other shape in document order: paragraphs, bullets as `- ` with two
 *    spaces of indent per `a:pPr@lvl`, tables (`a:tbl`) as Markdown tables
 *    with `|` escaped, group shapes recursed, and the speaker notes (the
 *    notes slide's body placeholder) as a `> Notes:` blockquote. Slide
 *    number, date and footer placeholders are dropped as noise;
 *  - pictures: the slide's image relationships (pictures in shape order, then
 *    any other image the slide references, e.g. a background), internal
 *    targets only — `TargetMode="External"` is never followed. PNG, JPEG, GIF
 *    and WebP (by content, not by extension) become image parts named
 *    `slide-<N>-image-<k>.<ext>` and are referenced in the Markdown as
 *    `[image: …]`; the same picture on a later slide references the part
 *    already returned. Other formats (emf, wmf, svg, tiff…) are skipped and
 *    counted in a note.
 *
 * One `text/markdown` part `<base>.md` comes first, then the image parts.
 * Every cap is reported: `maxPages` caps the slides read ("slides X–Y not
 * read"), `maxImages` / `maxImageBytes` the pictures (`[image not included]`
 * plus a note), `maxTextBytes` the Markdown (cut at a slide or line boundary,
 * `truncated`, notes naming what was kept). An image whose reference was cut
 * with the text is not returned.
 *
 * Hostile input: the archive goes through the bounded zip reader (declared
 * and actual inflated sizes capped) and only the parts needed are inflated;
 * XML is parsed by `fast-xml-parser` (an optional peer) with entity
 * processing off, and any part carrying a DOCTYPE is refused outright —
 * Office never writes one. The five predefined XML entities and numeric
 * character references are decoded here, without any expansion.
 */

import { McpToolError } from '../errors/index.js';
import { importPeer } from './peer.js';
import { pageRange } from './pdf-doc.js';
import { resolveConvertLimits, type ConvertedPart, type ConvertLimits, type ConvertResult, type ResolvedConvertLimits } from './types.js';
import { openZip, type ZipReader } from './zip-read.js';

/** A `fast-xml-parser` node in `preserveOrder` form: `{ tag: children, ':@': attrs }` or `{ '#text': … }`. */
type XNode = Record<string, unknown>;

type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
type ImagePart = Extract<ConvertedPart, { type: 'image' }>;

interface Rel {
  type: string;
  /** Resolved package path (no leading `/`), or the raw target when external. */
  target: string;
  external: boolean;
}

function fail(detail: string, cause?: unknown): McpToolError {
  return new McpToolError(`Could not read the presentation: ${detail}`, { kind: 'unknown', ...(cause !== undefined ? { cause } : {}) });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the predefined XML entities and numeric character references (nothing else is expanded). */
function decodeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (m, ref: string) => {
    if (ref[0] !== '#') return ENTITIES[ref] ?? m;
    const cp = ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '';
  });
}

function tagOf(n: XNode): string {
  for (const k of Object.keys(n)) if (k !== ':@') return k;
  return '';
}

function kids(n: XNode | undefined): XNode[] {
  if (!n) return [];
  const v = n[tagOf(n)];
  return Array.isArray(v) ? (v as XNode[]) : [];
}

function child(n: XNode | undefined, tag: string): XNode | undefined {
  return kids(n).find((k) => tagOf(k) === tag);
}

function attr(n: XNode | undefined, name: string): string | undefined {
  const a = n?.[':@'] as Record<string, unknown> | undefined;
  const v = a?.[name];
  return typeof v === 'string' ? decodeXml(v) : undefined;
}

type XmlParse = (xml: string) => XNode[];

async function xmlParser(): Promise<XmlParse> {
  const { XMLParser } = await importPeer('fast-xml-parser', () => import('fast-xml-parser'));
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: false,
    htmlEntities: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
  });
  return (xml) => parser.parse(xml) as XNode[];
}

/** Parsed parts per archive: a part several slides share (a notes slide, a layout) is parsed once (#436). */
const parsedParts = new WeakMap<ZipReader, Map<string, Promise<XNode[] | undefined>>>();

/** Read and parse one XML part; `undefined` when the archive has no such entry. */
function readXml(zip: ZipReader, parse: XmlParse, path: string): Promise<XNode[] | undefined> {
  let cache = parsedParts.get(zip);
  if (!cache) parsedParts.set(zip, (cache = new Map()));
  let p = cache.get(path);
  if (!p) {
    p = parseXmlPart(zip, parse, path);
    cache.set(path, p);
    p.catch(() => cache.delete(path));
  }
  return p;
}

async function parseXmlPart(zip: ZipReader, parse: XmlParse, path: string): Promise<XNode[] | undefined> {
  const text = await zip.readText(path);
  if (text === undefined) return undefined;
  if (/<!DOCTYPE/i.test(text)) throw fail(`${path} contains a DOCTYPE, which is refused.`);
  try {
    return parse(text);
  } catch (err) {
    throw fail(`${path}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]?.slice(0, 200)}`, err);
  }
}

function root(doc: XNode[] | undefined, tag: string): XNode | undefined {
  return doc?.find((n) => tagOf(n) === tag);
}

/** Resolve a relationship target against the directory of its source part; `undefined` if it escapes the package. */
function resolveTarget(sourcePart: string, target: string): string | undefined {
  const t = target.split('#')[0] ?? '';
  const segs = t.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
  for (const s of t.replace(/^\/+/, '').split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (segs.length === 0) return undefined;
      segs.pop();
    } else segs.push(s);
  }
  return segs.length > 0 ? segs.join('/') : undefined;
}

function relsPath(part: string): string {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

async function readRels(zip: ZipReader, parse: XmlParse, part: string): Promise<Map<string, Rel>> {
  const out = new Map<string, Rel>();
  for (const r of kids(root(await readXml(zip, parse, relsPath(part)), 'Relationships'))) {
    if (tagOf(r) !== 'Relationship') continue;
    const id = attr(r, 'Id');
    const type = attr(r, 'Type') ?? '';
    const target = attr(r, 'Target');
    if (!id || target === undefined) continue;
    if (attr(r, 'TargetMode') === 'External') {
      out.set(id, { type, target, external: true });
      continue;
    }
    const resolved = resolveTarget(part, target);
    if (resolved !== undefined) out.set(id, { type, target: resolved, external: false });
  }
  return out;
}

/** Text of one `a:p`: its runs, fields and breaks. */
function paragraphText(p: XNode): string {
  let s = '';
  for (const k of kids(p)) {
    const tag = tagOf(k);
    if (tag === 'a:r' || tag === 'a:fld') {
      for (const t of kids(child(k, 'a:t'))) if (typeof t['#text'] === 'string') s += decodeXml(t['#text']);
    } else if (tag === 'a:br') s += ' ';
  }
  return s.replace(/[\s\u000b]+/g, ' ').trim();
}

/** A text body's paragraphs as Markdown: bullets one per line, other paragraphs separated by a blank line. */
function textBody(body: XNode | undefined, bulletByDefault: boolean): string {
  const lines: Array<{ bullet: boolean; text: string }> = [];
  for (const p of kids(body)) {
    if (tagOf(p) !== 'a:p') continue;
    const text = paragraphText(p);
    if (text === '') continue;
    const pPr = child(p, 'a:pPr');
    const explicit = child(pPr, 'a:buChar') !== undefined || child(pPr, 'a:buAutoNum') !== undefined;
    const bullet = explicit || (bulletByDefault && child(pPr, 'a:buNone') === undefined);
    const lvl = Math.min(8, Math.max(0, Number.parseInt(attr(pPr, 'lvl') ?? '0', 10) || 0));
    lines.push({ bullet, text: bullet ? `${'  '.repeat(lvl)}- ${text}` : text });
  }
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out += lines[i - 1]!.bullet && lines[i]!.bullet ? '\n' : '\n\n';
    out += lines[i]!.text;
  }
  return out;
}

function tableMarkdown(tbl: XNode): string {
  const rows: string[][] = [];
  for (const tr of kids(tbl)) {
    if (tagOf(tr) !== 'a:tr') continue;
    const row: string[] = [];
    for (const tc of kids(tr)) {
      if (tagOf(tc) !== 'a:tc') continue;
      const merged = attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1';
      const text = merged
        ? ''
        : kids(child(tc, 'a:txBody'))
            .filter((p) => tagOf(p) === 'a:p')
            .map(paragraphText)
            .filter((t) => t !== '')
            .join(' ');
      row.push(text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|'));
    }
    rows.push(row);
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (width === 0) return '';
  const line = (r: string[]): string => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

/** A slide's content in order: Markdown chunks, and pictures by relationship id. */
type Chunk = string | { rId: string };

const SKIPPED_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'sldImg', 'hdr']);

function placeholderType(shape: XNode, nvTag: string): string | null | undefined {
  const ph = child(child(child(shape, nvTag), 'p:nvPr'), 'p:ph');
  if (!ph) return undefined;
  return attr(ph, 'type') ?? null;
}

/** Walk a shape tree, collecting the title (first title placeholder) and content chunks. */
function walkShapes(tree: XNode | undefined, acc: { title?: string; chunks: Chunk[] }): void {
  for (const shape of kids(tree)) {
    const tag = tagOf(shape);
    if (tag === 'p:sp') {
      const ph = placeholderType(shape, 'p:nvSpPr');
      if (typeof ph === 'string' && SKIPPED_PLACEHOLDERS.has(ph)) continue;
      const body = child(shape, 'p:txBody');
      if ((ph === 'title' || ph === 'ctrTitle') && acc.title === undefined) {
        acc.title = kids(body)
          .filter((p) => tagOf(p) === 'a:p')
          .map(paragraphText)
          .filter((t) => t !== '')
          .join(' ');
        continue;
      }
      const bulletByDefault = ph === null || ph === 'body' || ph === 'obj';
      const md = textBody(body, bulletByDefault);
      if (md !== '') acc.chunks.push(md);
    } else if (tag === 'p:grpSp') {
      walkShapes(shape, acc);
    } else if (tag === 'p:graphicFrame') {
      const tbl = child(child(child(shape, 'a:graphic'), 'a:graphicData'), 'a:tbl');
      if (tbl) {
        const md = tableMarkdown(tbl);
        if (md !== '') acc.chunks.push(md);
      }
    } else if (tag === 'p:pic') {
      const rId = attr(child(child(shape, 'p:blipFill'), 'a:blip'), 'r:embed');
      if (rId) acc.chunks.push({ rId });
    } else if (tag === 'mc:AlternateContent') {
      const alt = child(shape, 'mc:Fallback') ?? child(shape, 'mc:Choice');
      if (alt) walkShapes(alt, acc);
    }
  }
}

function spTree(doc: XNode[] | undefined, rootTag: string): XNode | undefined {
  return child(child(root(doc, rootTag), 'p:cSld'), 'p:spTree');
}

/** The body placeholder text of a notes slide. */
function notesText(doc: XNode[] | undefined): string {
  const out: string[] = [];
  const visit = (tree: XNode | undefined): void => {
    for (const shape of kids(tree)) {
      const tag = tagOf(shape);
      if (tag === 'p:grpSp') visit(shape);
      else if (tag === 'p:sp' && placeholderType(shape, 'p:nvSpPr') === 'body') {
        const t = textBody(child(shape, 'p:txBody'), false);
        if (t !== '') out.push(t);
      }
    }
  };
  visit(spTree(doc, 'p:notes'));
  return out.join('\n\n');
}

function sniffImage(b: Uint8Array): { mime: ImageMime; ext: string } | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { mime: 'image/gif', ext: 'gif' };
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' &&
    String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return undefined;
}

const SUPPORTED_EXT = new Set(['png', 'jpg', 'jpeg', 'jpe', 'gif', 'webp']);

/** Deck-wide picture bookkeeping: what was returned, and what was skipped and why. */
class ImageCollector {
  readonly parts: ImagePart[] = [];
  private readonly byTarget = new Map<string, string>();
  private bytes = 0;
  private readonly unsupported = new Map<string, number>();
  private overCount = 0;
  private overBytes = 0;
  private external = 0;
  private missing = 0;

  constructor(
    private readonly zip: ZipReader,
    private readonly lim: ResolvedConvertLimits,
  ) {}

  /** The Markdown for relationship `rel` on slide `slide` (`k` = images already named on this slide). */
  async resolve(rel: Rel | undefined, slide: number, perSlide: { k: number }): Promise<string> {
    if (!rel || !rel.type.endsWith('/image')) return '';
    if (rel.external) {
      this.external++;
      return '';
    }
    const known = this.byTarget.get(rel.target);
    if (known !== undefined) return `[image: ${known}]`;
    const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(rel.target)?.[1] ?? '').toLowerCase();
    if (!SUPPORTED_EXT.has(ext)) {
      this.unsupported.set(ext || 'unknown', (this.unsupported.get(ext || 'unknown') ?? 0) + 1);
      return '';
    }
    const entry = this.zip.entry(rel.target);
    if (!entry) {
      this.missing++;
      return '';
    }
    if (this.parts.length >= this.lim.maxImages) {
      this.overCount++;
      return '[image not included]';
    }
    if (this.bytes + entry.size > this.lim.maxImageBytes) {
      this.overBytes++;
      return '[image not included]';
    }
    const data = await this.zip.read(rel.target);
    if (!data) {
      this.missing++;
      return '';
    }
    const kind = sniffImage(data);
    if (!kind) {
      this.unsupported.set(`${ext} (unrecognised content)`, (this.unsupported.get(`${ext} (unrecognised content)`) ?? 0) + 1);
      return '';
    }
    if (this.bytes + data.length > this.lim.maxImageBytes) {
      this.overBytes++;
      return '[image not included]';
    }
    perSlide.k++;
    const name = `slide-${slide}-image-${perSlide.k}.${kind.ext}`;
    this.bytes += data.length;
    this.parts.push({ type: 'image', name, mimeType: kind.mime, data });
    this.byTarget.set(rel.target, name);
    return `[image: ${name}]`;
  }

  notes(): string[] {
    const n: string[] = [];
    const s = (k: number): string => (k === 1 ? '' : 's');
    const unsupportedTotal = [...this.unsupported.values()].reduce((a, b) => a + b, 0);
    if (unsupportedTotal > 0) {
      const kinds = [...this.unsupported.keys()];
      n.push(`${unsupportedTotal} image${s(unsupportedTotal)} skipped (unsupported format${s(kinds.length)}: ${kinds.join(', ')})`);
    }
    if (this.overCount > 0) n.push(`${this.overCount} image${s(this.overCount)} not included (maxImages is ${this.lim.maxImages})`);
    if (this.overBytes > 0) n.push(`${this.overBytes} image${s(this.overBytes)} not included (maxImageBytes is ${this.lim.maxImageBytes})`);
    if (this.external > 0) n.push(`${this.external} linked (external) image${s(this.external)} not fetched`);
    if (this.missing > 0) n.push(`${this.missing} image${s(this.missing)} missing from the archive`);
    return n;
  }
}

/** The base of an attachment file name: leaf only, `.pptx`/`.pptm` dropped, unsafe characters `_`; `presentation` when empty. */
function pptxBaseName(fileName: string | undefined): string {
  const leaf = (fileName ?? '').split(/[/\\]/).pop() ?? '';
  const base = leaf.replace(/\.(pptx|pptm)$/i, '').replace(/[:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  return base === '' ? 'presentation' : base;
}

/** One slide rendered: heading line and body (may be empty). */
async function renderSlide(
  zip: ZipReader,
  parse: XmlParse,
  part: string,
  n: number,
  images: ImageCollector,
): Promise<{ heading: string; body: string }> {
  const doc = await readXml(zip, parse, part);
  if (!doc) return { heading: `## Slide ${n}`, body: '*(slide content missing from the archive)*' };
  const sld = root(doc, 'p:sld');
  const hidden = attr(sld, 'show') === '0' || attr(sld, 'show') === 'false';
  const acc: { title?: string; chunks: Chunk[] } = { chunks: [] };
  walkShapes(spTree(doc, 'p:sld'), acc);
  const rels = await readRels(zip, parse, part);

  const perSlide = { k: 0 };
  const usedRIds = new Set<string>();
  const out: string[] = [];
  for (const c of acc.chunks) {
    if (typeof c === 'string') out.push(c);
    else {
      usedRIds.add(c.rId);
      const md = await images.resolve(rels.get(c.rId), n, perSlide);
      if (md !== '') out.push(md);
    }
  }
  // Images the slide relates to but no picture shape placed (backgrounds, fills).
  for (const [id, rel] of rels) {
    if (usedRIds.has(id) || !rel.type.endsWith('/image')) continue;
    const md = await images.resolve(rel, n, perSlide);
    if (md !== '' && !out.includes(md)) out.push(md);
  }
  const notesRel = [...rels.values()].find((r) => !r.external && r.type.endsWith('/notesSlide'));
  if (notesRel) {
    const notes = notesText(await readXml(zip, parse, notesRel.target));
    if (notes !== '') {
      const lines = notes.split('\n');
      out.push(lines.map((l, i) => (i === 0 ? `> Notes: ${l}` : l === '' ? '>' : `> ${l}`)).join('\n'));
    }
  }
  const title = acc.title ? `: ${acc.title}` : '';
  return { heading: `## Slide ${n}${title}${hidden ? ' (hidden)' : ''}`, body: out.join('\n\n') };
}

/**
 * Convert a .pptx deck to one `text/markdown` part (`<base>.md`, named after
 * `fileName`; `presentation` without one) plus one image part per embedded
 * picture returned. See the module header for the layout and the caps.
 * Throws an {@link McpToolError} for an oversized input or archive (kind
 * `'too_large'`), a missing `fflate`/`fast-xml-parser`, an XML part with a
 * DOCTYPE, or a zip that is not a presentation.
 */
export async function convertPptx(
  bytes: Uint8Array,
  limits?: ConvertLimits,
  signal?: AbortSignal,
  fileName?: string,
): Promise<ConvertResult> {
  signal?.throwIfAborted();
  const lim = resolveConvertLimits(limits);
  if (bytes.length > lim.maxInputBytes) {
    throw new McpToolError(`The presentation is ${bytes.length} bytes, over the ${lim.maxInputBytes}-byte input cap.`, { kind: 'too_large' });
  }
  const zip = await openZip(bytes, lim, signal);
  if (!zip.entry('ppt/presentation.xml')) throw fail('the archive has no ppt/presentation.xml (not a .pptx file).');
  const parse = await xmlParser();

  const pres = root(await readXml(zip, parse, 'ppt/presentation.xml'), 'p:presentation');
  const presRels = await readRels(zip, parse, 'ppt/presentation.xml');
  const slideParts: Array<string | undefined> = [];
  for (const s of kids(child(pres, 'p:sldIdLst'))) {
    if (tagOf(s) !== 'p:sldId') continue;
    const rel = presRels.get(attr(s, 'r:id') ?? '');
    slideParts.push(rel && !rel.external && rel.type.endsWith('/slide') ? rel.target : undefined);
  }
  const count = slideParts.length;

  const images = new ImageCollector(zip, lim);
  const notes: string[] = [];
  let text = '';
  let budget = lim.maxTextBytes;
  let truncated = false;
  const readCount = Math.min(count, lim.maxPages);
  // A slide part listed again is pointed at, never read and parsed again (#436).
  const firstListing = new Map<string, number>();
  let repeats = 0;
  for (let i = 0; i < readCount; i++) {
    signal?.throwIfAborted();
    const n = i + 1;
    const part = slideParts[i];
    const earlier = part === undefined ? undefined : firstListing.get(part);
    if (part !== undefined && earlier === undefined) firstListing.set(part, n);
    if (earlier !== undefined) repeats++;
    const { heading, body } =
      earlier !== undefined
        ? { heading: `## Slide ${n}`, body: `*(same slide as slide ${earlier})*` }
        : part
          ? await renderSlide(zip, parse, part, n, images)
          : { heading: `## Slide ${n}`, body: '*(slide content missing from the archive)*' };
    const block = body === '' ? `${heading}\n` : `${heading}\n\n${body}\n`;
    const sep = i === 0 ? '' : '\n';
    const size = Buffer.byteLength(sep + block);
    if (size <= budget) {
      text += sep + block;
      budget -= size;
      continue;
    }
    truncated = true;
    // Keep whole lines of this slide while they fit (heading first).
    const headSize = Buffer.byteLength(`${sep}${heading}\n\n`);
    const lines = body.split('\n');
    let kept = 0;
    if (body !== '' && headSize < budget) {
      let rest = budget - headSize;
      const keptLines: string[] = [];
      for (const l of lines) {
        const s = Buffer.byteLength(`${l}\n`);
        if (s > rest) break;
        keptLines.push(l);
        rest -= s;
      }
      while (keptLines.length > 0 && keptLines[keptLines.length - 1] === '') keptLines.pop();
      kept = keptLines.length;
      if (kept > 0) {
        text += `${sep}${heading}\n\n${keptLines.join('\n')}\n`;
        notes.push(`slide ${n}: kept lines 1–${kept} of ${lines.length} (the ${lim.maxTextBytes}-byte text cap was reached)`);
      }
    }
    const firstOut = kept > 0 ? n + 1 : n;
    if (firstOut <= readCount) {
      notes.push(`${pageRange(firstOut, readCount, 'slide')} not included (the ${lim.maxTextBytes}-byte text cap was reached)`);
    }
    break;
  }
  if (repeats > 0) notes.push(`${repeats} slide listing${repeats === 1 ? '' : 's'} repeat an earlier slide (a slide listed more than once); each is shown as a pointer, not read again`);
  if (count > readCount) notes.push(`${pageRange(readCount + 1, count, 'slide')} not read (maxPages is ${lim.maxPages})`);
  notes.push(...images.notes());

  // A picture whose reference was cut with the text is not returned.
  const imageParts = truncated ? images.parts.filter((p) => text.includes(`[image: ${p.name}]`)) : images.parts;
  const parts: ConvertedPart[] = [
    { type: 'text', name: `${pptxBaseName(fileName)}.md`, mimeType: 'text/markdown', text, ...(truncated ? { truncated: true } : {}) },
    ...imageParts,
  ];
  return { format: 'pptx', parts, notes, count };
}
