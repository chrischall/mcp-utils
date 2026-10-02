/**
 * Replace a file atomically: write a private temp file beside it (`0600`),
 * flush it to disk, then rename it over the target. A concurrent reader sees
 * the old file or the new one — never a truncated half of one, which is what an
 * in-place `writeFileSync` exposes mid-write (mcp-utils#330: a fresh-mode
 * `SessionStore` reader quarantined a live store it caught half-written).
 *
 * The temp name is unique per call so two writers never share (and tear) one.
 * On failure the temp file is removed and the error re-thrown; the target is
 * untouched. Directory creation/permissions stay the caller's business.
 *
 * Internal to the session module; not exported from the package.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';

export function writeFileAtomicSync(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Tighten BEFORE the rename: fresh secrets never sit in a loose file.
    chmodSync(tmp, 0o600);
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}
