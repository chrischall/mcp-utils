// The CLI the fleet CI runs (chrischall/workflows reusable-mcp-ci.yml): walk a
// repo, lint server source, exit non-zero on an unconfined call.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'audit-fs-confinement.mjs');
const IMPORT = "import { fileBlob, resolveOutputDir } from '@chrischall/mcp-utils';\n";

let root;
const repo = (files) => {
  root = mkdtempSync(join(tmpdir(), 'fs-confinement-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
};
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });

afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

describe('audit-fs-confinement.mjs', () => {
  it('fails on an unconfined call and names file, line and call', () => {
    repo({ 'src/upload.ts': `${IMPORT}\nexport const f = (p: string) => fileBlob(p, { type: 'image/png' });\n` });
    const r = run('.');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("src/upload.ts:3:33: fileBlob(p, { type: 'image/png' }) passes no allowedRoots");
    expect(r.stdout).toContain('1 unconfined');
  });

  it('passes a repo whose calls are all confined, and says how many it checked', () => {
    repo({
      'src/upload.ts': `${IMPORT}fileBlob(p, { allowedRoots: roots });\nresolveOutputDir(undefined, 'X_OUTPUT_DIR');\n`,
      'packages/b/src/out.mts': `${IMPORT}resolveOutputDir(dir, 'B_OUTPUT_DIR', { allowedRoots: [base] });\n`,
    });
    const r = run('.');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/3 file-helper calls? in 2 files?, all confined/);
  });

  it('passes a repo that never calls the helpers', () => {
    repo({ 'src/index.ts': "import { readEnvVar } from '@chrischall/mcp-utils';\n" });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0 file-helper calls');
  });

  it('skips tests, dependencies and build output', () => {
    const bad = `${IMPORT}fileBlob(p);\n`;
    repo({
      'tests/upload.test.ts': bad,
      'src/upload.test.ts': bad,
      'src/__tests__/x.ts': bad,
      'node_modules/dep/index.js': bad,
      'dist/bundle.js': bad,
      'src/types.d.ts': bad,
      'src/ok.ts': "export const x = 1;\n",
    });
    expect(run('.').status).toBe(0);
  });

  it('emits GitHub annotations with --github', () => {
    repo({ 'src/a.ts': `${IMPORT}fileBlob(p);\n` });
    const r = run('.', '--github');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^::error file=src\/a\.ts,line=2,col=1::fileBlob\(p\) passes no allowedRoots/m);
  });

  it('checks several roots and reports paths relative to the cwd', () => {
    repo({ 'a/src/x.ts': `${IMPORT}fileBlob(p);\n`, 'b/src/y.ts': `${IMPORT}fileBlob(q);\n` });
    const r = run('a', 'b');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('a/src/x.ts:2:1');
    expect(r.stdout).toContain('b/src/y.ts:2:1');
  });

  it('exits 2 on a root that does not exist', () => {
    repo({});
    const r = run('nope');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('nope');
  });

  it('warns (exit 0) on a conditional allowedRoots spread, and fails with --strict', () => {
    repo({ 'src/up.ts': `${IMPORT}fileBlob(p, { ...(roots ? { allowedRoots: roots } : {}) });\n` });
    const r = run('.');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('src/up.ts:2:1: warning: fileBlob(');
    expect(r.stdout).toContain('only inside a conditional spread');
    expect(r.stdout).toContain('1 warning');
    expect(run('.', '--strict').status).toBe(1);
    expect(run('.', '--github').stdout).toMatch(/^::warning file=src\/up\.ts,line=2,col=1::/m);
  });

  it('warns (exit 0) on a raw fs write with a non-literal path, and fails with --strict', () => {
    repo({ 'src/save.ts': "import { writeFileSync } from 'node:fs';\nexport const save = (p: string) => writeFileSync(p, 'x');\n" });
    const r = run('.');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("src/save.ts:2:36: warning: writeFileSync(p, 'x') writes a non-literal path");
    expect(r.stdout).toMatch(/1 raw fs write/);
    expect(run('.', '--strict').status).toBe(1);
    expect(run('.', '--github').stdout).toMatch(/^::warning file=src\/save\.ts,line=2,col=36::/m);
  });

  it('warns (exit 0, still) on a require()d fs write and a computed rename destination', () => {
    repo({ 'src/save.cjs': "const fs = require('node:fs');\nexports.save = (p) => fs.renameSync('/tmp/x', p);\n" });
    const r = run('.');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("src/save.cjs:2:23: warning: fs.renameSync('/tmp/x', p) writes a non-literal path");
    expect(run('.', '--strict').status).toBe(1);
  });

  it('still fails an unconfined helper call without --strict', () => {
    repo({ 'src/a.ts': `${IMPORT}fileBlob(p);\n`, 'src/b.ts': "import { mkdirSync } from 'fs';\nmkdirSync(d);\n" });
    const r = run('.');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('1 unconfined');
  });
});
