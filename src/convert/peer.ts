/**
 * Loading the optional peer libraries the converters run on.
 *
 * `unpdf`, `exceljs`, `fflate`, `fast-xml-parser` and `@napi-rs/canvas` are
 * optional peers: each is `import()`ed inside the function that needs it, so a
 * consumer that never converts a given format need not install its library.
 */

import { McpToolError } from '../errors/index.js';

function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/**
 * Run `load` (a dynamic `import()` of `pkg`); a missing package becomes an
 * {@link McpToolError} naming it and how to install it. Any other failure is
 * rethrown unchanged.
 */
export async function importPeer<T>(pkg: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (!isModuleNotFound(err)) throw err;
    throw new McpToolError(`Converting this attachment needs the optional package "${pkg}", which is not installed.`, {
      hint: `npm install ${pkg}`,
      kind: 'unknown',
      cause: err,
    });
  }
}
