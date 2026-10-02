import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { createSpentTokenStore } from './confirm-token.js';
import { confirmWrite } from './confirm-write.js';
import { MERGED_UPDATE_NOTE, mergeOverCurrent, prepareMergedUpdate, revisionOf } from './merge-write.js';

describe('mergeOverCurrent', () => {
  it('lays the defined patch fields over the current resource', () => {
    expect(mergeOverCurrent({ a: 1, b: 'keep', c: [1] }, { a: 2, c: [9] })).toEqual({ a: 2, b: 'keep', c: [9] });
  });

  it('keeps the current value for an undefined or null patch field', () => {
    expect(mergeOverCurrent({ a: 1, b: 2 }, { a: undefined, b: null, c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('keeps falsy-but-defined patch values (0, "", false)', () => {
    expect(mergeOverCurrent({ a: 5, b: 'x', c: true }, { a: 0, b: '', c: false })).toEqual({ a: 0, b: '', c: false });
  });

  it('is shallow: a patched nested object replaces the current one', () => {
    expect(mergeOverCurrent({ attrs: { x: 1, y: 2 } }, { attrs: { x: 3 } })).toEqual({ attrs: { x: 3 } });
  });

  it('mutates neither input', () => {
    const current = { a: 1 };
    const patch = { b: 2 };
    mergeOverCurrent(current, patch);
    expect(current).toEqual({ a: 1 });
    expect(patch).toEqual({ b: 2 });
  });

  it('cannot pollute Object.prototype through a "__proto__" patch key', () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const merged = mergeOverCurrent({}, patch);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });
});

describe('revisionOf', () => {
  it('reads updatedAt by default', () => {
    expect(revisionOf({ updatedAt: '2024-01-15T10:00:00Z', x: 1 })).toBe('2024-01-15T10:00:00Z');
  });

  it('reads a named field, and a numeric version as its string form', () => {
    expect(revisionOf({ etag: 'W/"7"' }, 'etag')).toBe('W/"7"');
    expect(revisionOf({ version: 3 }, 'version')).toBe('3');
  });

  it.each([
    ['no field', { other: 1 }],
    ['an empty string', { updatedAt: '' }],
    ['a non-finite number', { updatedAt: Number.NaN }],
    ['an object', { updatedAt: { at: 1 } }],
    ['a non-object resource', 'nope'],
    ['an array', [{ updatedAt: 'x' }]],
    ['null', null],
  ])('is undefined for %s', (_label, raw) => {
    expect(revisionOf(raw)).toBeUndefined();
  });
});

describe('prepareMergedUpdate', () => {
  it('reads, maps, merges and reports the revision', async () => {
    const raw = { id: 5, updatedAt: 'r1', description: 'keep me', timeSpentSeconds: 3600, author: { accountId: 'u1' } };
    const read = vi.fn(async () => raw);
    const out = await prepareMergedUpdate({
      read,
      toInput: (r) => {
        const o = r as typeof raw;
        return { description: o.description, timeSpentSeconds: o.timeSpentSeconds, authorAccountId: o.author.accountId };
      },
      patch: { timeSpentSeconds: 7200, description: undefined },
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(out.body).toEqual({ description: 'keep me', timeSpentSeconds: 7200, authorAccountId: 'u1' });
    expect(out.revision).toBe('r1');
    expect(out.raw).toBe(raw);
    expect(out.current).toEqual({ description: 'keep me', timeSpentSeconds: 3600, authorAccountId: 'u1' });
  });

  it('defaults toInput to the resource itself (non-objects become {})', async () => {
    expect((await prepareMergedUpdate({ read: async () => ({ a: 1 }), patch: { b: 2 } })).body).toEqual({ a: 1, b: 2 });
    expect((await prepareMergedUpdate({ read: async () => 'junk', patch: { b: 2 } })).body).toEqual({ b: 2 });
  });

  it('lets adjust drop a derived current field before the merge (tempo billableSeconds)', async () => {
    const out = await prepareMergedUpdate({
      read: async () => ({ timeSpentSeconds: 3600, billableSeconds: 3600 }),
      patch: { timeSpentSeconds: 7200 },
      adjust: (current, patch) => {
        if (patch.timeSpentSeconds !== undefined && current.billableSeconds === current.timeSpentSeconds) {
          delete current.billableSeconds;
        }
      },
    });
    expect(out.body).toEqual({ timeSpentSeconds: 7200 });
  });

  it('adjust works on a copy: the resource read is not mutated', async () => {
    const raw = { a: 1, b: 2 };
    const out = await prepareMergedUpdate({ read: async () => raw, patch: {}, adjust: (c) => void delete c.a });
    expect(raw).toEqual({ a: 1, b: 2 });
    expect(out.current).toEqual({ b: 2 });
  });

  it('takes a revision reader: a field name, a function, or false for none', async () => {
    const raw = { updatedAt: 'u', etag: 'e' };
    expect((await prepareMergedUpdate({ read: async () => raw, patch: {}, revision: 'etag' })).revision).toBe('e');
    expect((await prepareMergedUpdate({ read: async () => raw, patch: {}, revision: (r) => `${(r as typeof raw).etag}!` })).revision).toBe('e!');
    // `false` means no revision at all — never a field literally named "false".
    const odd = { updatedAt: 'u', false: 'f' };
    expect((await prepareMergedUpdate({ read: async () => odd, patch: {}, revision: false })).revision).toBeUndefined();
  });

  it('propagates a failed read without merging anything', async () => {
    const toInput = vi.fn();
    await expect(prepareMergedUpdate({ read: async () => Promise.reject(new Error('404')), toInput, patch: {} })).rejects.toThrow('404');
    expect(toInput).not.toHaveBeenCalled();
  });
});

describe('prepareMergedUpdate composes with confirmWrite', () => {
  const ctx = {
    mcpReq: {
      envelope: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': { extensions: {} },
      },
    },
  } as unknown as ServerContext;
  const text = (r: unknown) => JSON.parse(((r as CallToolResult).content[0] as { text: string }).text);

  async function gate(server: { updatedAt: string; description: string }, confirmToken: string | undefined, spent: ReturnType<typeof createSpentTokenStore>) {
    const { body, revision } = await prepareMergedUpdate({ read: async () => ({ ...server }), patch: { timeSpentSeconds: 60 } });
    return confirmWrite(ctx, {
      tool: 'x_update',
      action: 'thing.update',
      summary: 'Update thing 5',
      account: undefined,
      target: '5',
      revision,
      request: { method: 'PUT', path: '/things/5', body },
      confirmToken,
      spent,
      env: {},
    });
  }

  it('the preview shows the full merged body, and an edit between the phases is refused', async () => {
    const spent = createSpentTokenStore();
    const server = { updatedAt: 'r1', description: 'theirs' };
    const p1 = text(await gate(server, undefined, spent));
    expect(p1.status).toBe('confirmation-required');
    expect(JSON.stringify(p1)).toContain('"description":"theirs"');

    server.updatedAt = 'r2'; // someone edits it before the confirmed call
    expect(text(await gate(server, p1.confirmToken, spent))).toMatchObject({ error: 'DRAFT_CHANGED', reason: 'revision-changed' });
  });

  it('an unchanged resource passes the gate on the confirmed call', async () => {
    const spent = createSpentTokenStore();
    const server = { updatedAt: 'r1', description: 'theirs' };
    const p1 = text(await gate(server, undefined, spent));
    expect(await gate(server, p1.confirmToken, spent)).toBeUndefined();
  });
});

describe('MERGED_UPDATE_NOTE', () => {
  it('tells the model omitted fields keep their values and a concurrent edit is refused', () => {
    expect(MERGED_UPDATE_NOTE).toMatch(/omit keep their current values/);
    expect(MERGED_UPDATE_NOTE).toMatch(/refused rather than overwritten/);
  });
});
