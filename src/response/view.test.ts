import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { VIEWS, DEFAULT_VIEW, viewParam, resolveView, viewResult, minifiedResult, projectOrRaw } from './view.js';

afterEach(() => vi.restoreAllMocks());

describe('the vocabulary', () => {
  it('is exactly compact, full, raw — in ascending order of size', () => {
    expect(VIEWS).toEqual(['compact', 'full', 'raw']);
  });

  it('defaults to compact, because efficiency is not something a caller should have to ask for', () => {
    expect(DEFAULT_VIEW).toBe('compact');
  });
});

describe('viewParam', () => {
  it('offers only the rungs the tool honours, so the schema never advertises a no-op', () => {
    const schema = viewParam(['compact', 'full']);
    expect(schema.parse('full')).toBe('full');
    expect(schema.parse(undefined)).toBeUndefined();
    expect(() => schema.parse('raw')).toThrow();
  });

  it('describes only those rungs, and never mentions one it would reject', () => {
    const text = viewParam(['compact', 'full']).description ?? '';
    expect(text).toMatch(/"compact" \(default\)/);
    expect(text).toContain('"full"');
    expect(text).not.toContain('"raw"');
  });

  it('appends the tool’s own note about what compact drops', () => {
    const text = viewParam(['compact', 'full'], { note: 'compact drops listData.' }).description ?? '';
    expect(text).toContain('compact drops listData.');
  });

  it('refuses to build a param that does not offer the default', () => {
    // A tool whose only rungs are full and raw has no cheap answer at all,
    // which is the one shape this vocabulary exists to prevent.
    expect(() => viewParam(['full', 'raw'])).toThrow(/compact/);
  });

  it('refuses a single-rung param, which is a parameter that decides nothing', () => {
    expect(() => viewParam(['compact'])).toThrow(/at least two/);
  });
});

describe('resolveView', () => {
  it('answers compact for an absent value', () => {
    expect(resolveView(undefined, ['compact', 'full'])).toBe('compact');
  });

  it('passes an honoured value through', () => {
    expect(resolveView('full', ['compact', 'full'])).toBe('full');
  });

  it('falls back to compact for a value this tool does not honour, rather than throwing', () => {
    // The schema already rejects it; this is the second line, and it fails
    // toward the CHEAP answer — a caller that somehow asks for `raw` on a tool
    // without one gets a small correct response, not a 500.
    expect(resolveView('raw', ['compact', 'full'])).toBe('compact');
  });
});

describe('whitespace', () => {
  const data = { a: 1, b: [{ c: 2 }] };

  it('minifies compact and full: pretty-printing is bytes a model pays for and cannot read', () => {
    expect(viewResult('compact', data).content[0]).toEqual({ type: 'text', text: '{"a":1,"b":[{"c":2}]}' });
    expect(viewResult('full', data).content[0]).toEqual({ type: 'text', text: '{"a":1,"b":[{"c":2}]}' });
  });

  it('leaves raw indented, because that rung exists to be read by a person', () => {
    const text = (viewResult('raw', data).content[0] as { text: string }).text;
    expect(text).toBe(JSON.stringify(data, null, 2));
  });

  it('minifiedResult is the same rule without a view to hand', () => {
    expect(minifiedResult(data).content[0]).toEqual({ type: 'text', text: '{"a":1,"b":[{"c":2}]}' });
  });

  /**
   * The distinction the whole rule turns on: FORMATTING whitespace is removed,
   * whitespace INSIDE a value is content and is untouched.
   *
   * `JSON.stringify(x)` gets this right for free — it drops only the indent
   * and the run after `:` and `,` — but any hand-rolled minifier (a regex over
   * the serialised text, a `.replace(/\s+/g, ' ')`) silently corrupts every
   * body that has a blank line in it, and an ofw-mcp message page is nothing
   * but bodies with blank lines in them. Pinned so that a future "faster"
   * implementation cannot pass.
   */
  it('never touches whitespace INSIDE a value — that is content, not formatting', () => {
    const body = 'Line one.\n\nLine two, after a blank line.\n  Indented continuation.\tTabbed.\n\nTrailing spaces:   ';
    const payload = { body, subject: '  padded  ', poem: '\n\n\n', empty: '' };
    const text = (minifiedResult(payload).content[0] as { text: string }).text;
    // The only true test is the round trip: parse it back and compare bytes.
    expect(JSON.parse(text)).toEqual(payload);
    expect(JSON.parse(text).body).toBe(body);
    // And the newlines are still there, as escapes rather than real breaks.
    expect(text).toContain('\\n\\n');
    expect(text.split('\n')).toHaveLength(1);
  });

  it('round-trips a real message body through every rung unchanged', () => {
    const body = 'I sent a text today.\n\nAlso:\n  - one\n  - two\n\nThanks ';
    for (const view of VIEWS) {
      const text = (viewResult(view, { body }).content[0] as { text: string }).text;
      expect(JSON.parse(text).body).toBe(body);
    }
  });

  it('preserves key order, which several repos make load-bearing', () => {
    const text = (minifiedResult({ complete: false, messages: [] }).content[0] as { text: string }).text;
    expect(text).toBe('{"complete":false,"messages":[]}');
  });
});

describe('projectOrRaw', () => {
  const opts = { label: 'demo-mcp', context: 'GET /things' };

  it('returns the projection when it succeeds', () => {
    expect(projectOrRaw({ a: 1, b: 2 }, (v) => ({ a: v.a }), opts)).toEqual({ a: 1 });
  });

  it('returns the RAW value when the projector throws, and says so on stderr', () => {
    // The property that makes compact-by-default survivable on a
    // reverse-engineered API: upstream drifts, the projector trips, and the
    // caller gets everything rather than an empty or wrong record.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = { unexpected: 'shape' };
    expect(projectOrRaw(raw, () => { throw new Error('no items[]'); }, opts)).toBe(raw);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('demo-mcp'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GET /things'));
  });

  it('does not swallow the reason — the message names what tripped', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    projectOrRaw({}, () => { throw new Error('items[] was not an array'); }, opts);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('items[] was not an array'));
  });

  it('treats an undefined projection as a failed one, never as an empty answer', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = { a: 1 };
    expect(projectOrRaw(raw, () => undefined as unknown as { a: number }, opts)).toBe(raw);
    expect(warn).toHaveBeenCalled();
  });
});

describe('the param is a real zod schema', () => {
  it('composes into an inputSchema the SDK accepts', () => {
    const shape = { id: z.string(), view: viewParam(['compact', 'full']) };
    expect(z.object(shape).parse({ id: 'x' })).toEqual({ id: 'x' });
    expect(z.object(shape).parse({ id: 'x', view: 'full' })).toEqual({ id: 'x', view: 'full' });
  });
});
