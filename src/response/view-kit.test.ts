import { afterEach, describe, expect, it, vi } from 'vitest';
import { createViewKit, viewArg, viewResponse } from './view.js';

// fleet-audit#1348: viator-mcp `src/view.ts` (the reference — an optional
// projector), tripadvisor-mcp, eventbrite-mcp and getyourguide-mcp each wrap
// viewParam/resolveView/stripMediaUrls/minifiedResult in the same two helpers.

const VIEWS = ['compact', 'full'] as const;
const text = (r: { content: Array<{ type: string; text?: string }> }): string => r.content[0]!.text!;

const record = { id: 1, name: 'Tour', coverImageUrl: 'https://cdn.example.com/a.jpg', images: [{ url: 'https://cdn.example.com/b.jpg' }] };

describe('viewResponse', () => {
  it('compact with no projector strips media URLs, minified (eventbrite / viator media tools)', () => {
    const out = text(viewResponse(undefined, record, { views: VIEWS }));
    expect(JSON.parse(out)).toEqual({ id: 1, name: 'Tour' });
    expect(out).not.toContain('\n');
  });

  it('compact with a projector runs the projection INSTEAD of media stripping — a projection that keeps an image keeps it (viator #72)', () => {
    const project = (d: unknown) => ({ id: (d as typeof record).id, coverImageUrl: (d as typeof record).coverImageUrl });
    expect(JSON.parse(text(viewResponse('compact', record, { views: VIEWS, project })))).toEqual({
      id: 1,
      coverImageUrl: 'https://cdn.example.com/a.jpg',
    });
  });

  it('full returns the data untouched, minified, and never runs the projector', () => {
    let ran = false;
    const out = text(
      viewResponse('full', record, {
        views: VIEWS,
        project: () => {
          ran = true;
          return {};
        },
      }),
    );
    expect(JSON.parse(out)).toEqual(record);
    expect(out).not.toContain('\n');
    expect(ran).toBe(false);
  });

  it('raw stays indented, as viewResult does', () => {
    const out = text(viewResponse('raw', { a: 1 }, { views: ['compact', 'full', 'raw'] }));
    expect(out).toBe('{\n  "a": 1\n}');
  });

  describe('a projector that loses its footing falls back to the unprojected payload (fleet-audit#1442)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a projector returning undefined never yields a text-less block — it returns the payload and warns', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = viewResponse('compact', record, { views: VIEWS, project: () => undefined, label: 'demo-mcp', context: 'GET /tours' });
      expect(typeof out.content[0]!.text).toBe('string');
      expect(JSON.parse(text(out))).toEqual(record);
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/^\[demo-mcp\] WARNING: could not project GET \/tours \(the projection produced nothing\)/));
    });

    it('a throwing projector does not take the call down — it returns the payload and warns', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = viewResponse('compact', record, {
        views: VIEWS,
        project: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'items')");
        },
      });
      expect(JSON.parse(text(out))).toEqual(record);
      expect(err).toHaveBeenCalledWith(expect.stringContaining("reading 'items'"));
    });

    it('the kit passes its label through to the warning', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const kit = createViewKit(VIEWS, { label: 'kit-mcp' });
      expect(JSON.parse(text(kit.viewResponse('compact', record, () => undefined)))).toEqual(record);
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/^\[kit-mcp\]/));
    });
  });

  it('a rung the tool does not honour falls back to compact, like resolveView', () => {
    expect(JSON.parse(text(viewResponse('raw', record, { views: VIEWS })))).toEqual({ id: 1, name: 'Tour' });
  });
});

describe('viewArg', () => {
  it('is viewParam over the tool views with the note appended', () => {
    const schema = viewArg(VIEWS, 'compact strips image URLs.');
    expect(schema.parse('full')).toBe('full');
    expect(schema.parse(undefined)).toBeUndefined();
    expect(() => schema.parse('raw')).toThrow();
    expect(schema.description).toMatch(/compact strips image URLs\.$/);
  });

  it('works without a note', () => {
    expect(viewArg(VIEWS).description).toMatch(/^Response shape:/);
  });
});

describe('createViewKit', () => {
  it('binds a repo-wide rung list and default note — the shape every donor exports', () => {
    const kit = createViewKit(VIEWS, { note: 'DEFAULT NOTE' });
    expect(kit.views).toEqual(VIEWS);
    expect(kit.viewArg().description).toMatch(/DEFAULT NOTE$/);
    expect(kit.viewArg('OWN NOTE').description).toMatch(/OWN NOTE$/);
    expect(JSON.parse(text(kit.viewResponse(undefined, record)))).toEqual({ id: 1, name: 'Tour' });
    expect(JSON.parse(text(kit.viewResponse('compact', record, () => ({ only: 'projection' }))))).toEqual({ only: 'projection' });
    expect(JSON.parse(text(kit.viewResponse('full', record)))).toEqual(record);
  });

  it('refuses a rung list viewParam would refuse, at construction', () => {
    expect(() => createViewKit(['full', 'raw'])).toThrow(/compact/);
  });
});
