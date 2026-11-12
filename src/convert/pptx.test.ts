import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { McpToolError } from '../errors/index.js';
import { convertPptx } from './pptx.js';
import type { ConvertedPart, ConvertResult } from './types.js';

const enc = new TextEncoder();

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A 1×1 PNG. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
  0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63,
  0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60,
  0x82,
]);
/** JPEG magic plus filler. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

function sp(opts: { ph?: string; noPh?: boolean; paras: string[] }): string {
  const ph = opts.ph ? `<p:nvPr><p:ph type="${opts.ph}"/></p:nvPr>` : opts.noPh ? '<p:nvPr><p:ph idx="1"/></p:nvPr>' : '<p:nvPr/>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/>${ph}</p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${opts.paras.join('')}</p:txBody></p:sp>`;
}

function para(text: string, pPr = ''): string {
  return `<a:p>${pPr}<a:r><a:t>${text}</a:t></a:r></a:p>`;
}

function pic(rId: string): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/></p:blipFill><p:spPr/></p:pic>`;
}

function table(rows: string[][]): string {
  const trs = rows
    .map((r) => `<a:tr h="1">${r.map((c) => `<a:tc><a:txBody><a:bodyPr/>${para(c)}</a:txBody></a:tc>`).join('')}</a:tr>`)
    .join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid/>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function slideXml(shapes: string, attrs = ''): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}${attrs}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`;
}

function rels(list: Array<{ id: string; type: string; target: string; external?: boolean }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map((r) => `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('')}</Relationships>`;
}

interface SlideSpec {
  /** File number: ppt/slides/slide<file>.xml */
  file: number;
  shapes: string;
  attrs?: string;
  rels?: Array<{ id: string; type: string; target: string; external?: boolean }>;
  notes?: string;
}

/** Build a minimal .pptx: slides listed in deck order (their file numbers may differ). */
function deck(slides: SlideSpec[], extra: Record<string, Uint8Array> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const sldIds = slides.map((s, i) => `<p:sldId id="${256 + i}" r:id="rIdS${s.file}"/>`).join('');
  files['ppt/presentation.xml'] = enc.encode(
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS}><p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`,
  );
  files['ppt/_rels/presentation.xml.rels'] = enc.encode(
    rels([
      { id: 'rIdM', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
      ...slides.map((s) => ({ id: `rIdS${s.file}`, type: 'slide', target: `slides/slide${s.file}.xml` })),
    ]),
  );
  for (const s of slides) {
    files[`ppt/slides/slide${s.file}.xml`] = enc.encode(slideXml(s.shapes, s.attrs));
    const r = [...(s.rels ?? [])];
    if (s.notes !== undefined) {
      r.push({ id: 'rIdN', type: 'notesSlide', target: `../notesSlides/notesSlide${s.file}.xml` });
      files[`ppt/notesSlides/notesSlide${s.file}.xml`] = enc.encode(
        `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${sp({ ph: 'sldImg', paras: [] })}${sp({ ph: 'body', paras: [para(s.notes)] })}${sp({ ph: 'sldNum', paras: [para('7')] })}</p:spTree></p:cSld></p:notes>`,
      );
    }
    if (r.length > 0) files[`ppt/slides/_rels/slide${s.file}.xml.rels`] = enc.encode(rels(r));
  }
  return zipSync({ ...files, ...extra });
}

function md(r: ConvertResult): string {
  const p = r.parts[0];
  if (p?.type !== 'text') throw new Error('expected the markdown part first');
  return p.text;
}

function images(r: ConvertResult): Array<Extract<ConvertedPart, { type: 'image' }>> {
  return r.parts.filter((p): p is Extract<ConvertedPart, { type: 'image' }> => p.type === 'image');
}

describe('convertPptx', () => {
  it('renders title, bullets with levels, plain text boxes and speaker notes', async () => {
    const bytes = deck([
      {
        file: 1,
        shapes:
          sp({ ph: 'title', paras: [para('Quarterly review')] }) +
          sp({ noPh: true, paras: [para('Revenue up'), para('EMEA', '<a:pPr lvl="1"/>'), para('Costs flat')] }) +
          sp({ paras: [para('A plain text box')] }) +
          sp({ ph: 'sldNum', paras: [para('1')] }),
        notes: 'Mention the hiring freeze',
      },
    ]);
    const r = await convertPptx(bytes, undefined, undefined, 'Deck.pptx');
    expect(r.format).toBe('pptx');
    expect(r.count).toBe(1);
    expect(r.parts[0]).toMatchObject({ type: 'text', name: 'Deck.md', mimeType: 'text/markdown' });
    expect(md(r)).toBe(
      '## Slide 1: Quarterly review\n\n- Revenue up\n  - EMEA\n- Costs flat\n\nA plain text box\n\n> Notes: Mention the hiring freeze\n',
    );
    expect(r.notes).toEqual([]);
  });

  it('orders slides by presentation.xml, not file name (slide10 after slide2)', async () => {
    const bytes = deck([
      { file: 2, shapes: sp({ ph: 'ctrTitle', paras: [para('Two')] }) },
      { file: 10, shapes: sp({ ph: 'title', paras: [para('Ten')] }) },
      { file: 1, shapes: sp({ paras: [para('untitled body')] }) },
    ]);
    const r = await convertPptx(bytes);
    expect(r.count).toBe(3);
    expect(md(r)).toBe('## Slide 1: Two\n\n## Slide 2: Ten\n\n## Slide 3\n\nuntitled body\n');
  });

  it('renders tables as Markdown with | escaped, and recurses into group shapes', async () => {
    const bytes = deck([
      {
        file: 1,
        shapes:
          table([
            ['Name', 'Value'],
            ['a|b', '1'],
          ]) + `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp({ paras: [para('inside group')] })}</p:grpSp>`,
      },
    ]);
    const r = await convertPptx(bytes);
    expect(md(r)).toBe('## Slide 1\n\n| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n\ninside group\n');
  });

  // chrischall/mcp-utils#436: a deck listing one slide many times must not
  // inflate and parse that slide again for every listing.
  it('renders a slide listed again as a pointer to its first listing, without re-reading it', async () => {
    const s1 = { file: 1, shapes: sp({ ph: 'title', paras: [para('Only once')] }) };
    const bytes = deck([s1, s1, s1]);
    const r = await convertPptx(bytes);
    const text = md(r);
    expect(text.match(/Only once/g)).toHaveLength(1);
    expect(text).toContain('## Slide 2');
    expect(text).toContain('same slide as slide 1');
    expect(text).toContain('## Slide 3');
    expect(r.count).toBe(3);
    expect(r.notes.join(' ')).toMatch(/listed more than once/);
  });

  it('marks hidden slides', async () => {
    const r = await convertPptx(deck([{ file: 1, shapes: sp({ ph: 'title', paras: [para('Secret')] }), attrs: ' show="0"' }]));
    expect(md(r)).toBe('## Slide 1: Secret (hidden)\n');
  });

  it('returns embedded images as parts, referenced in the markdown; external links and emf are skipped with notes', async () => {
    const bytes = deck(
      [
        {
          file: 1,
          shapes: sp({ ph: 'title', paras: [para('Pics')] }) + pic('rId1') + pic('rId2') + pic('rId3') + pic('rId4'),
          rels: [
            { id: 'rId1', type: 'image', target: '../media/image1.png' },
            { id: 'rId2', type: 'image', target: 'https://evil.example/x.png', external: true },
            { id: 'rId3', type: 'image', target: '../media/image2.emf' },
            { id: 'rId4', type: 'image', target: '../media/image3.jpeg' },
          ],
        },
        { file: 2, shapes: pic('rId1'), rels: [{ id: 'rId1', type: 'image', target: '../media/image1.png' }] },
      ],
      {
        'ppt/media/image1.png': PNG,
        'ppt/media/image2.emf': new Uint8Array([1, 0, 0, 0]),
        'ppt/media/image3.jpeg': JPEG,
      },
    );
    const r = await convertPptx(bytes);
    const imgs = images(r);
    expect(imgs.map((i) => [i.name, i.mimeType])).toEqual([
      ['slide-1-image-1.png', 'image/png'],
      ['slide-1-image-2.jpg', 'image/jpeg'],
    ]);
    expect(imgs[0]!.data).toEqual(PNG);
    // The same picture on slide 2 references the part already returned.
    expect(md(r)).toBe(
      '## Slide 1: Pics\n\n[image: slide-1-image-1.png]\n\n[image: slide-1-image-2.jpg]\n\n## Slide 2\n\n[image: slide-1-image-1.png]\n',
    );
    expect(r.notes.some((n) => /1 image .*unsupported format.*emf/.test(n))).toBe(true);
    expect(r.notes.some((n) => /external/.test(n))).toBe(true);
    expect(md(r)).not.toContain('evil.example');
  });

  it('honours maxImages and maxImageBytes, noting what was left out', async () => {
    const bytes = deck(
      [
        {
          file: 1,
          shapes: pic('rId1') + pic('rId2'),
          rels: [
            { id: 'rId1', type: 'image', target: '../media/a.png' },
            { id: 'rId2', type: 'image', target: '../media/b.png' },
          ],
        },
      ],
      { 'ppt/media/a.png': PNG, 'ppt/media/b.png': PNG.slice() },
    );
    const byCount = await convertPptx(bytes, { maxImages: 1 });
    expect(images(byCount).map((i) => i.name)).toEqual(['slide-1-image-1.png']);
    expect(md(byCount)).toContain('[image not included]');
    expect(byCount.notes.some((n) => /1 image.*not included.*maxImages is 1/.test(n))).toBe(true);

    const byBytes = await convertPptx(bytes, { maxImageBytes: PNG.length + 10 });
    expect(images(byBytes)).toHaveLength(1);
    expect(byBytes.notes.some((n) => /maxImageBytes/.test(n))).toBe(true);
  });

  it('skips an image whose bytes do not match its extension', async () => {
    const bytes = deck(
      [{ file: 1, shapes: pic('rId1'), rels: [{ id: 'rId1', type: 'image', target: '../media/fake.png' }] }],
      { 'ppt/media/fake.png': enc.encode('<svg/>') },
    );
    const r = await convertPptx(bytes);
    expect(images(r)).toEqual([]);
    expect(r.notes.some((n) => /unsupported format/.test(n))).toBe(true);
  });

  it('honours maxPages as max slides', async () => {
    const bytes = deck([1, 2, 3].map((n) => ({ file: n, shapes: sp({ ph: 'title', paras: [para(`S${n}`)] }) })));
    const r = await convertPptx(bytes, { maxPages: 1 });
    expect(md(r)).toBe('## Slide 1: S1\n');
    expect(r.count).toBe(3);
    expect(r.notes).toContain('slides 2–3 not read (maxPages is 1)');
  });

  it('honours maxTextBytes at a line boundary, marking the part truncated', async () => {
    const bytes = deck([
      { file: 1, shapes: sp({ ph: 'title', paras: [para('One')] }) + sp({ paras: [para('x'.repeat(40)), para('y'.repeat(40))] }) },
      { file: 2, shapes: sp({ ph: 'title', paras: [para('Two')] }) },
    ]);
    const r = await convertPptx(bytes, { maxTextBytes: 70 });
    expect(r.parts[0]).toMatchObject({ truncated: true });
    expect(md(r)).toBe(`## Slide 1: One\n\n${'x'.repeat(40)}\n`);
    expect(Buffer.byteLength(md(r))).toBeLessThanOrEqual(70);
    expect(r.notes.some((n) => /slide 1: kept lines/.test(n))).toBe(true);
    expect(r.notes.some((n) => /slide 2 not included/.test(n))).toBe(true);
  });

  it('refuses XML with a DOCTYPE (no entity expansion)', async () => {
    const files: Record<string, Uint8Array> = {
      'ppt/presentation.xml': enc.encode(
        `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><p:presentation ${NS}><p:sldIdLst/></p:presentation>`,
      ),
    };
    await expect(convertPptx(zipSync(files))).rejects.toThrow(/DOCTYPE/);
  });

  it('throws a clear McpToolError for a zip that is not a presentation', async () => {
    const err = await convertPptx(zipSync({ 'hello.txt': enc.encode('hi') })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/ppt\/presentation\.xml/);
  });

  it('refuses an input over maxInputBytes', async () => {
    const err = await convertPptx(deck([{ file: 1, shapes: '' }]), { maxInputBytes: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
  });

  it('refuses a zip bomb through the bounded reader', async () => {
    const bytes = deck([{ file: 1, shapes: '' }], { 'ppt/media/big.png': new Uint8Array(1024 * 1024) });
    const err = await convertPptx(bytes, { maxUnzippedBytes: 64 * 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
  });

  it('honours an aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(convertPptx(deck([{ file: 1, shapes: '' }]), undefined, ac.signal)).rejects.toThrow();
  });
});
