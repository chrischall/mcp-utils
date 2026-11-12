import { describe, expect, it, vi } from 'vitest';

// pdf.js refuses an encrypted PDF it has no password for with a PasswordException.
vi.mock('unpdf', () => ({
  getDocumentProxy: () => Promise.reject(Object.assign(new Error('No password given'), { name: 'PasswordException' })),
}));

const { McpToolError } = await import('../errors/index.js');
const { convertPdf, extractPdfText } = await import('./pdf.js');

describe('a password-protected PDF', () => {
  it.each([
    ['convertPdf', () => convertPdf(new TextEncoder().encode('%PDF-1.7 encrypted'), 'auto')],
    ['extractPdfText', () => extractPdfText(new TextEncoder().encode('%PDF-1.7 encrypted'))],
  ])('%s throws an McpToolError that says so, with a hint', async (_name, run) => {
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toBe('Could not read the PDF: the PDF is password-protected');
    expect((err as InstanceType<typeof McpToolError>).hint).toBe('The PDF is password-protected; open it and save an unprotected copy.');
  });
});
