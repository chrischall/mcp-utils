import { describe, expect, it } from 'vitest';
import { McpToolError } from '../errors/index.js';
import { importPeer } from './peer.js';

describe('importPeer', () => {
  it('returns the loaded module', async () => {
    await expect(importPeer('fflate', async () => ({ ok: 1 }))).resolves.toEqual({ ok: 1 });
  });

  it('turns a missing optional package into an McpToolError naming it', async () => {
    const missing = Object.assign(new Error("Cannot find package 'exceljs'"), { code: 'ERR_MODULE_NOT_FOUND' });
    const err = await importPeer('exceljs', () => Promise.reject(missing)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).message).toMatch(/exceljs/);
    expect((err as McpToolError).hint).toMatch(/npm install exceljs/);
  });

  it('rethrows any other load failure unchanged', async () => {
    const boom = new Error('boom');
    await expect(importPeer('exceljs', () => Promise.reject(boom))).rejects.toBe(boom);
  });
});
