#!/usr/bin/env node
/**
 * Fail when server source calls mcp-utils' file helpers without confinement.
 *
 *   node scripts/audit-fs-confinement.mjs                 # the current directory
 *   node scripts/audit-fs-confinement.mjs ../some-mcp     # another repo
 *   node scripts/audit-fs-confinement.mjs . --github      # GitHub annotations
 *
 * Every call to `fileBlob`, `readFileHead` or `resolveOutputDir` imported from
 * `@chrischall/mcp-utils` must pass `allowedRoots` (resolveOutputDir with a
 * literal `undefined` per-call dir excepted). The rule and why it reads source
 * rather than the wire: lib/fs-confinement.mjs (fleet-audit#945).
 *
 * Walks each root, skipping node_modules, build output and tests. Exits 1 on
 * any unconfined call, 2 on bad usage, 0 otherwise — and always says how many
 * calls it checked, so a lint that saw nothing is visible as such.
 *
 * Zero dependencies: the fleet CI runs it from a bare clone of this repo at a
 * release tag (chrischall/workflows reusable-mcp-ci.yml), beside the
 * confirm-gate lint in audit-annotations.mjs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { findFsHelperCalls, isLintedSourceFile, SKIPPED_DIRS } from './lib/fs-confinement.mjs';

const args = process.argv.slice(2);
const github = args.includes('--github');
const roots = args.filter((a) => a !== '--github');
if (roots.length === 0) roots.push('.');
for (const r of roots) {
  if (r.startsWith('--')) {
    console.error(`unknown option ${r}\nusage: audit-fs-confinement.mjs [root ...] [--github]`);
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
let checked = 0;
let files = 0;
const findings = [];
const seen = new Set();
for (const root of roots) {
  for (const file of walk(root)) {
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    if (!BARE.test(src) || !HELPER.test(src)) continue;
    const calls = findFsHelperCalls(src);
    if (calls.length === 0) continue;
    files++;
    checked += calls.length;
    for (const { confined, ...f } of calls) if (!confined) findings.push({ file: file.split(sep).join('/'), ...f });
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
for (const f of findings) {
  const msg = `${f.text} passes no allowedRoots — a model-chosen path here is unconfined. Pass allowedRoots (the directories this tool may ${f.helper === 'resolveOutputDir' ? 'write into' : 'read'}, e.g. from a <SVC>_UPLOAD_DIR / <SVC>_OUTPUT_DIR setting).`;
  console.log(github
    ? `::error file=${f.file},line=${f.line},col=${f.column}::${msg}`
    : `${f.file}:${f.line}:${f.column}: ${msg}`);
}
const summary = `${plural(checked, 'file-helper call', 'file-helper calls')} in ${plural(files, 'file', 'files')}`;
if (findings.length > 0) {
  console.log(`fs confinement: ${summary}, ${findings.length} unconfined.`);
  process.exit(1);
}
console.log(`fs confinement: ${summary}, all confined.`);
