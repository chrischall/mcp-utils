/**
 * Opt-in root confinement for tool-supplied filesystem paths.
 *
 * The upload/output helpers ({@link fileBlob}, {@link readFileHead},
 * {@link resolveOutputDir}) take paths straight from tool arguments. In a
 * hosted child, a prompt-injected path (the state dir, `/proc/self/environ`)
 * would otherwise be read and uploaded upstream. Passing `allowedRoots` makes
 * each helper resolve the real path (following symlinks) and refuse anything
 * that is not inside one of the roots. Omitting it keeps the old, unconfined
 * behaviour, so existing callers are unaffected.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { expandPath } from '../config/index.js';

/** Whether `target` (a real, absolute path) lies inside `root` (also real). */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * The real path of `p`, following symlinks. When `p` (or part of its tail)
 * does not exist yet — an output dir about to be created — the nearest
 * existing ancestor is resolved and the missing tail appended, so a symlinked
 * parent cannot smuggle the new directory out of the root.
 */
function realPathAllowingMissing(p: string): string {
  const abs = resolve(p);
  let existing = abs;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(existing.slice(parent.length).replace(/^[/\\]+/, ''));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    real = existing;
  }
  return tail.length > 0 ? resolve(real, ...tail) : real;
}

/**
 * Resolve `path` to its real absolute path and require it to be inside one of
 * `roots` (each `~`-expanded and resolved through symlinks too). Returns the
 * real path; throws when it is outside every root. A path that does not exist
 * yet is checked through its nearest existing ancestor.
 *
 * Exported for tools that open paths themselves; {@link fileBlob},
 * {@link readFileHead} and {@link resolveOutputDir} call it when given
 * `allowedRoots`.
 */
export function assertPathWithinRoots(path: string, roots: readonly string[]): string {
  const target = realPathAllowingMissing(expandPath(path));
  for (const root of roots) {
    if (isInside(realPathAllowingMissing(expandPath(root)), target)) return target;
  }
  throw new Error(`Path is outside the allowed directories: ${path}`);
}
