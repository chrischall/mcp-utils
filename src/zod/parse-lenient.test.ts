import { afterEach, describe, expect, it, vi } from 'vitest';

import { z } from 'zod';

import { McpToolError } from '../errors/index.js';
import { parseLenient } from './index.js';

const Envelope = z.object({ items: z.array(z.object({ id: z.number() })) });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseLenient', () => {
  it('returns the parsed data on success', () => {
    const out = parseLenient(Envelope, { items: [{ id: 1 }] }, { label: 'foo-mcp', context: 'search response' });
    expect(out).toEqual({ items: [{ id: 1 }] });
  });

  it('lenient mode: warns to stderr and returns the RAW value on drift', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = { items: [{ id: 'not-a-number' }], extra: true };
    const out = parseLenient(Envelope, raw, { label: 'foo-mcp', context: 'search response' });
    expect(out).toBe(raw); // the raw reference, so callers can still ?? their way through
    expect(warn).toHaveBeenCalledOnce();
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain('[foo-mcp]');
    expect(msg).toContain('search response');
    expect(msg).toContain('items.0.id');
  });

  it('strict mode: throws an McpToolError naming the context', () => {
    expect(() =>
      parseLenient(Envelope, { items: 'nope' }, { label: 'foo-mcp', context: 'detail response', mode: 'strict' }),
    ).toThrow(McpToolError);
  });

  it('success emits no warning', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    parseLenient(Envelope, { items: [] }, { label: 'foo-mcp', context: 'x' });
    expect(warn).not.toHaveBeenCalled();
  });
});
