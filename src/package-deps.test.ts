import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * audit 2026-09 (DEP-1): every package the published code imports — including
 * `import type` (it survives into the emitted .d.ts) and dynamic `import()` —
 * must be declared, or strict installers (pnpm without hoisting, Yarn PnP)
 * cannot resolve it for consumers.
 */
const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
const builtins = new Set(builtinModules);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

describe('declared dependencies', () => {
  it('declares every external package imported by published source', () => {
    const missing = new Set<string>();
    // Real module specifiers only: `import …/export … from '…'` statements at
    // the start of a line, and dynamic `import('…')` (optionally with a
    // `/* @vite-ignore */` comment). Prose inside strings/comments is ignored.
    const re = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\s*\(\s*(?:\/\*[^*]*\*\/\s*)?['"]([^'"]+)['"]/gm;
    for (const file of sourceFiles(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(re)) {
        const spec = (m[1] ?? m[2] ?? m[3])!;
        if (spec.startsWith('.') || spec.startsWith('node:') || builtins.has(spec)) continue;
        const name = packageName(spec);
        if (!declared.has(name)) missing.add(`${name} (${file.slice(root.length + 1)})`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
