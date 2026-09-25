// fleet-audit#945: the source half of the fleet lint. A tool that hands a
// model-chosen path to mcp-utils' file helpers without `allowedRoots` can be
// steered (by a prompt injection) at any file the server can read — or, for
// resolveOutputDir, any directory it can create. Path confinement is not
// visible on the wire, so this reads source. Pure, so tested on strings.
import { describe, expect, it } from 'vitest';

import { findFsHelperCalls, findUnconfinedFsCalls, isLintedSourceFile } from './fs-confinement.mjs';

const lines = (findings) => findings.map((f) => `${f.line}:${f.column} ${f.helper}`);

describe('findUnconfinedFsCalls', () => {
  it('flags each helper called without allowedRoots', () => {
    const src = [
      "import { fileBlob, readFileHead, resolveOutputDir } from '@chrischall/mcp-utils';",
      'const a = await fileBlob(path, { type: mime });',
      'const b = await readFileHead(abs, 16);',
      "const c = resolveOutputDir(args.output_dir, 'X_OUTPUT_DIR');",
    ].join('\n');
    expect(lines(findUnconfinedFsCalls(src))).toEqual(['2:17 fileBlob', '3:17 readFileHead', '4:11 resolveOutputDir']);
  });

  it('passes calls that pass allowedRoots — as a key, shorthand, or conditional spread', () => {
    const src = [
      "import { fileBlob, readFileHead, resolveOutputDir } from '@chrischall/mcp-utils';",
      'await fileBlob(p, { type: m, allowedRoots: roots });',
      'await readFileHead(p, 16, { allowedRoots });',
      "resolveOutputDir(dir, 'X_OUTPUT_DIR', { ...(roots ? { allowedRoots: roots } : {}) });",
      'await fileBlob(p, {',
      '  maxBytes: 5,',
      '  allowedRoots: [root],',
      '});',
    ].join('\n');
    expect(findUnconfinedFsCalls(src)).toEqual([]);
  });

  it('does not count allowedRoots that is only in a comment or a string', () => {
    const src = [
      "import { fileBlob } from '@chrischall/mcp-utils';",
      'await fileBlob(p /* allowedRoots: later */, { label: "allowedRoots" });',
      'await fileBlob(p, { label: `allowedRoots` }); // allowedRoots',
    ].join('\n');
    expect(lines(findUnconfinedFsCalls(src))).toEqual(['2:7 fileBlob', '3:7 fileBlob']);
  });

  it('does not count allowedRoots belonging to a LATER call on the same line', () => {
    const src = [
      "import { fileBlob } from '@chrischall/mcp-utils';",
      'const [a, b] = [await fileBlob(p), await fileBlob(q, { allowedRoots: r })];',
    ].join('\n');
    expect(lines(findUnconfinedFsCalls(src))).toEqual(['2:23 fileBlob']);
  });

  it('exempts resolveOutputDir(undefined, …): no per-call path, only operator config', () => {
    const src = [
      "import { resolveOutputDir } from '@chrischall/mcp-utils';",
      "resolveOutputDir(undefined, 'X_OUTPUT_DIR');",
      "resolveOutputDir( undefined , 'X_OUTPUT_DIR', { env });",
      "resolveOutputDir(undefinedish, 'X_OUTPUT_DIR');",
    ].join('\n');
    expect(lines(findUnconfinedFsCalls(src))).toEqual(['4:1 resolveOutputDir']);
  });

  it('follows aliases and namespace imports, from the root barrel or any subpath', () => {
    const src = [
      "import { fileBlob as blobOf, readEnvVar } from '@chrischall/mcp-utils';",
      "import * as mu from \"@chrischall/mcp-utils\";",
      "import def, { readFileHead as head } from '@chrischall/mcp-utils/fs';",
      'await blobOf(p);',
      'await mu.readFileHead(p, 4);',
      'await mu?.fileBlob(p, { allowedRoots: r });',
      'await head(p, 4);',
      'readEnvVar("X");',
    ].join('\n');
    expect(lines(findUnconfinedFsCalls(src))).toEqual(['4:7 fileBlob', '5:7 readFileHead', '7:7 readFileHead']);
  });

  it('reads multi-line, semicolon-free imports', () => {
    const src = [
      "import './polyfill'",
      'import {',
      '  readEnvVar,',
      '  fileBlob,',
      "} from '@chrischall/mcp-utils'",
      'await fileBlob(p)',
    ].join('\n');
    expect(lines(findUnconfinedFsCalls(src))).toEqual(['6:7 fileBlob']);
  });

  it('ignores a same-named helper that is NOT from mcp-utils (a repo-local resolveOutputDir)', () => {
    const src = [
      "import { readEnvVar } from '@chrischall/mcp-utils';",
      "import { resolveOutputDir } from './images.js';",
      'export function fileBlob(p: string) { return p; }',
      'resolveOutputDir(args.output_dir);',
      'fileBlob(p);',
      'client.fileBlob(p);',
    ].join('\n');
    expect(findUnconfinedFsCalls(src)).toEqual([]);
  });

  it('ignores type-only imports, a similarly named package, and a mention that is not a call', () => {
    const src = [
      "import type { fileBlob } from '@chrischall/mcp-utils';",
      "import { type readFileHead, sniffMimeBytes } from '@chrischall/mcp-utils';",
      "import { resolveOutputDir } from '@chrischall/mcp-utils-extra';",
      "import { fileBlob as fb } from '@chrischall/mcp-utils';",
      'const helpers = { fb };',
      'readFileHead(p, 1); resolveOutputDir(d, "E");',
    ].join('\n');
    expect(findUnconfinedFsCalls(src)).toEqual([]);
  });

  it('is not fooled by parentheses, quotes or regexes inside the arguments', () => {
    const src = [
      "import { fileBlob } from '@chrischall/mcp-utils';",
      "await fileBlob(join(dir, ')'), { type: /\\)/.test(x) ? 'a)' : `b${f(')')}`, allowedRoots: r });",
      "await fileBlob(join(dir, '('), { type: 'x' });",
      'const re = /fileBlob\\(p\\)/; const s = "fileBlob(q)"; // fileBlob(z)',
      '/* fileBlob(w) */',
    ].join('\n');
    expect(lines(findUnconfinedFsCalls(src))).toEqual(['3:7 fileBlob']);
  });

  it('reports a call inside a template-literal expression', () => {
    const src = [
      "import { resolveOutputDir } from '@chrischall/mcp-utils';",
      'const msg = `wrote to ${resolveOutputDir(o, "E")}`;',
    ].join('\n');
    expect(lines(findUnconfinedFsCalls(src))).toEqual(['2:25 resolveOutputDir']);
  });

  it('includes the call text (trimmed) for the report', () => {
    const src = "import { fileBlob } from '@chrischall/mcp-utils';\nawait fileBlob(real, { type: mimeType });";
    expect(findUnconfinedFsCalls(src)[0]).toMatchObject({
      helper: 'fileBlob',
      local: 'fileBlob',
      line: 2,
      column: 7,
      text: 'fileBlob(real, { type: mimeType })',
    });
  });
});

describe('findFsHelperCalls', () => {
  it('lists every helper call, confined or not, so a caller can report coverage', () => {
    const src = [
      "import { fileBlob, resolveOutputDir } from '@chrischall/mcp-utils';",
      'fileBlob(p, { allowedRoots: r });',
      "resolveOutputDir(undefined, 'E');",
      'fileBlob(q);',
    ].join('\n');
    expect(findFsHelperCalls(src).map((c) => [c.line, c.helper, c.confined])).toEqual([
      [2, 'fileBlob', true],
      [3, 'resolveOutputDir', true],
      [4, 'fileBlob', false],
    ]);
  });
});

describe('isLintedSourceFile', () => {
  it.each([
    ['src/client.ts', true],
    ['src/tools/checkin.mts', true],
    ['packages/a/src/x.js', true],
    ['src/ui.tsx', true],
    ['scripts/build.mjs', true],
    ['src/types.d.ts', false],
    ['src/client.test.ts', false],
    ['src/client.spec.mjs', false],
    ['tests/tools/shared.ts', false],
    ['packages/a/test/helpers.ts', false],
    ['src/__tests__/x.ts', false],
    ['src/__mocks__/fs.ts', false],
    ['test-fixtures/bad.ts', true],
    ['README.md', false],
  ])('%s → %s', (path, want) => {
    expect(isLintedSourceFile(path)).toBe(want);
  });
});
