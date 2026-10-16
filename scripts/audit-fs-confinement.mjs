#!/usr/bin/env node
/**
 * Fail when server source calls mcp-utils' file helpers without confinement.
 *
 *   node scripts/audit-fs-confinement.mjs                 # the current directory
 *   node scripts/audit-fs-confinement.mjs ../some-mcp     # another repo
 *   node scripts/audit-fs-confinement.mjs . --github      # GitHub annotations
 *   node scripts/audit-fs-confinement.mjs . --strict      # warnings fail too
 *
 * Every call to `fileBlob`, `readFileHead` or `resolveOutputDir` imported from
 * `@chrischall/mcp-utils` must pass `allowedRoots` (resolveOutputDir with a
 * literal `undefined` per-call dir excepted). The rule and why it reads source
 * rather than the wire: lib/fs-confinement.mjs (fleet-audit#945).
 *
 * It also WARNS on two things the helper rule cannot prove safe: an
 * `allowedRoots` passed only inside a conditional spread (unconfined whenever
 * the condition is falsy), and a raw `node:fs` write / mkdir whose path is not
 * a literal. Warnings do not fail the run unless `--strict` is given, so the
 * fleet CI surfaces them without breaking (fleet audit 2026-10-15).
 *
 * Walks each root, skipping node_modules, build output and tests. Exits 1 on
 * any unconfined call (or, with --strict, any warning), 2 on bad usage, 0
 * otherwise — and always says how many calls it checked, so a lint that saw
 * nothing is visible as such.
 *
 * Zero dependencies: the fleet CI runs it from a bare clone of this repo at a
 * release tag (chrischall/workflows reusable-mcp-ci.yml), beside the
 * confirm-gate lint in audit-annotations.mjs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { findFsHelperCalls, findRawFsWrites, isLintedSourceFile, SKIPPED_DIRS } from './lib/fs-confinement.mjs';

const FLAGS = new Set(['--github', '--strict']);
const args = process.argv.slice(2);
const github = args.includes('--github');
const strict = args.includes('--strict');
const roots = args.filter((a) => !FLAGS.has(a));
if (roots.length === 0) roots.push('.');
for (const r of roots) {
  if (r.startsWith('--')) {
    console.error(`unknown option ${r}\nusage: audit-fs-confinement.mjs [root ...] [--github] [--strict]`);
    process.exit(2);
  }
  if (!existsSync(r) || !statSync(r).isDirectory()) {
    console.error(`not a directory: ${r}`);
    process.exit(2);
  }
}

/** Every linted source file under `dir`, as a path relative to the cwd. */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile()) {
      const rel = relative('.', full) || full;
      if (isLintedSourceFile(rel)) yield rel;
    }
  }
}

const BARE = /@chrischall\/mcp-utils/;
const HELPER = /\b(?:fileBlob|readFileHead|resolveOutputDir)\b/;
const FS_IMPORT = /['"](?:node:)?fs(?:\/promises)?['"]/;
let checked = 0;
let files = 0;
let rawWrites = 0;
const findings = [];
const warnings = [];
const seen = new Set();
for (const root of roots) {
  for (const file of walk(root)) {
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    const rel = file.split(sep).join('/');
    if (FS_IMPORT.test(src)) {
      for (const w of findRawFsWrites(src)) {
        rawWrites++;
        warnings.push({ file: rel, line: w.line, column: w.column, msg: `${w.text} writes a non-literal path with node:fs — if any part of it can come from a tool argument it is unconfined. Use writeFileSafe / writeUniqueFile with allowedRoots, or confirm the path is operator-configured only.` });
      }
    }
    if (!BARE.test(src) || !HELPER.test(src)) continue;
    const calls = findFsHelperCalls(src);
    if (calls.length === 0) continue;
    files++;
    checked += calls.length;
    for (const { confined, conditional, ...f } of calls) {
      if (!confined) findings.push({ file: rel, ...f });
      else if (conditional) {
        warnings.push({ file: rel, line: f.line, column: f.column, msg: `${f.text} passes allowedRoots only inside a conditional spread — the call is unconfined whenever the condition is falsy. Pass allowedRoots unconditionally (default the roots to the ${f.helper === 'resolveOutputDir' ? 'output' : 'upload'} directory).` });
      }
    }
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
for (const f of findings) {
  const msg = `${f.text} passes no allowedRoots — a model-chosen path here is unconfined. Pass allowedRoots (the directories this tool may ${f.helper === 'resolveOutputDir' ? 'write into' : 'read'}, e.g. from a <SVC>_UPLOAD_DIR / <SVC>_OUTPUT_DIR setting).`;
  console.log(github
    ? `::error file=${f.file},line=${f.line},col=${f.column}::${msg}`
    : `${f.file}:${f.line}:${f.column}: ${msg}`);
}
for (const w of warnings) {
  const level = strict ? 'error' : 'warning';
  console.log(github
    ? `::${level} file=${w.file},line=${w.line},col=${w.column}::${w.msg}`
    : `${w.file}:${w.line}:${w.column}: ${level}: ${w.msg}`);
}
const summary = `${plural(checked, 'file-helper call', 'file-helper calls')} in ${plural(files, 'file', 'files')}`;
const tail =
  `; ${plural(rawWrites, 'raw fs write', 'raw fs writes')} with a computed path` +
  (warnings.length > 0 ? `; ${plural(warnings.length, 'warning', 'warnings')}${strict ? ' (--strict: failing)' : ''}` : '');
if (findings.length > 0 || (strict && warnings.length > 0)) {
  console.log(`fs confinement: ${summary}, ${findings.length} unconfined${tail}.`);
  process.exit(1);
}
console.log(`fs confinement: ${summary}, all confined${tail}.`);
