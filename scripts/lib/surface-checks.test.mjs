// Fleet low-severity audit, library candidates clusters 2, 3 and 9: the
// warn-only surface checks audit-annotations.mjs runs beside the confirm-gate
// lint. Pure, so tested here without starting a server; the CLI wiring is in
// ../audit-annotations.test.mjs.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  annotationHintFindings,
  collectEnvReads,
  envDriftFindings,
  collectSurfaceWarnings,
  findPackageDir,
  formatWarning,
  loadSurface,
  manifestToolDriftFindings,
  mcpConfigPathFindings,
  mcpJsonPathFindings,
  resolvePluginMcp,
} from './surface-checks.mjs';

const tool = (name, annotations) => ({ name, ...(annotations === undefined ? {} : { annotations }) });
const codes = (fs) => fs.map((f) => `${f.code}:${f.subject}`);

describe('annotationHintFindings', () => {
  it('flags a non-read tool whose destructiveHint is not an explicit boolean', () => {
    const fs = annotationHintFindings([
      tool('send', { readOnlyHint: false, openWorldHint: true }),
      tool('bare'),
      tool('fav', { readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
      tool('del', { readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
      tool('list', { readOnlyHint: true, openWorldHint: true }),
    ]);
    expect(codes(fs.filter((f) => f.code === 'destructive-implicit'))).toEqual([
      'destructive-implicit:bare',
      'destructive-implicit:send',
    ]);
    expect(fs.find((f) => f.subject === 'send').message).toMatch(/destructiveHint.*defaults to true/i);
  });

  it('flags any tool, read or not, with no explicit openWorldHint', () => {
    const fs = annotationHintFindings([
      tool('list', { readOnlyHint: true }),
      tool('calc', { readOnlyHint: true, openWorldHint: false }),
      tool('net', { readOnlyHint: true, openWorldHint: true }),
      tool('bare'),
    ]);
    expect(codes(fs.filter((f) => f.code === 'open-world-missing'))).toEqual([
      'open-world-missing:bare',
      'open-world-missing:list',
    ]);
  });

  it('tags every finding with its check and reports nothing for a fully annotated set', () => {
    const fs = annotationHintFindings([tool('x', { readOnlyHint: false })]);
    expect(fs.every((f) => f.check === 'annotations')).toBe(true);
    expect(annotationHintFindings([
      tool('a', { readOnlyHint: true, openWorldHint: true }),
      tool('b', { readOnlyHint: false, destructiveHint: false, openWorldHint: false }),
    ])).toEqual([]);
  });
});

describe('manifestToolDriftFindings', () => {
  const manifest = (names, extra = {}) => ({ tools: names.map((name) => ({ name, description: 'd' })), ...extra });

  it('reports a served tool the manifest omits, and a listed tool nothing serves', () => {
    const fs = manifestToolDriftFindings(manifest(['a', 'gone']), ['a', 'b', 'svc_healthcheck'], 'manifest.json');
    expect(codes(fs)).toEqual([
      'manifest-missing-tool:b',
      'manifest-missing-tool:svc_healthcheck',
      'manifest-stale-tool:gone',
    ]);
    expect(fs.every((f) => f.check === 'manifest-tools' && f.file === 'manifest.json')).toBe(true);
  });

  it('passes an exact match in any order', () => {
    expect(manifestToolDriftFindings(manifest(['b', 'a']), ['a', 'b'], 'manifest.json')).toEqual([]);
  });

  it('checks only the stale direction when tools_generated says the list is partial', () => {
    const fs = manifestToolDriftFindings(manifest(['a', 'gone'], { tools_generated: true }), ['a', 'b'], 'manifest.json');
    expect(codes(fs)).toEqual(['manifest-stale-tool:gone']);
  });

  it('says nothing when the manifest has no tools[] at all', () => {
    expect(manifestToolDriftFindings({ name: 'x' }, ['a'], 'manifest.json')).toEqual([]);
  });
});

describe('collectEnvReads', () => {
  it('collects literal keys from the mcp-utils readers and process.env, required vs optional', () => {
    const reads = collectEnvReads(`
      const a = readEnvVar('SVC_BASE_URL');
      const b = requireEnvVar("SVC_TOKEN", { hint: 'x' });
      const c = parseBoolEnv('SVC_DEBUG', { default: false });
      const d = readPortEnv('SVC_WS_PORT', 3000);
      const e = readIntEnv(\`SVC_LIMIT\`);
      const f = readTtlMsEnv('SVC_TTL_MS', 1000);
      const g = process.env.SVC_RAW;
      const h = process.env['SVC_BRACKET'];
      const i = readEnvVar2('SVC_BUNDLED');           // esbuild de-dupe suffix
      const j = readEnvVar(name);                    // dynamic: invisible
    `);
    expect([...reads.keys()].sort()).toEqual([
      'SVC_BASE_URL', 'SVC_BRACKET', 'SVC_BUNDLED', 'SVC_DEBUG', 'SVC_LIMIT',
      'SVC_RAW', 'SVC_TOKEN', 'SVC_TTL_MS', 'SVC_WS_PORT',
    ]);
    expect(reads.get('SVC_TOKEN')).toEqual({ required: true, optional: false });
    expect(reads.get('SVC_BASE_URL')).toEqual({ required: false, optional: true });
  });

  it('records both kinds when a key is read both ways', () => {
    const reads = collectEnvReads("readEnvVar('K'); requireEnvVar('K');");
    expect(reads.get('K')).toEqual({ required: true, optional: true });
  });
});

describe('envDriftFindings', () => {
  const code = (src) => ({ text: src, reads: collectEnvReads(src) });

  it('warns on a key the code reads that manifest.json and server.json do not declare', () => {
    const fs = envDriftFindings({
      code: code("requireEnvVar('SVC_TOKEN'); readEnvVar('SVC_OUTPUT_DIR');"),
      manifest: { file: 'manifest.json', json: { server: { mcp_config: { env: { SVC_TOKEN: '${user_config.token}' } } }, user_config: { token: { type: 'string', required: true } } } },
      serverJson: { file: 'server.json', json: { packages: [{ environmentVariables: [{ name: 'SVC_TOKEN', isRequired: true }] }] } },
    });
    expect(codes(fs)).toEqual([
      'env-undeclared:SVC_OUTPUT_DIR',
      'env-undeclared:SVC_OUTPUT_DIR',
    ]);
    expect(fs.map((f) => f.file)).toEqual(['manifest.json', 'server.json']);
  });

  it('warns on a declared key the built code never mentions (dead config)', () => {
    const fs = envDriftFindings({
      code: code("readEnvVar('SVC_TOKEN'); const opts = { debugEnvVar: 'SVC_FP_DEBUG' };"),
      manifest: { file: 'manifest.json', json: { server: { mcp_config: { env: { SVC_TOKEN: 'x', SVC_FP_DEBUG: 'x', SVC_OLD: 'x' } } } } },
      mcpJson: { file: '.mcp.json', json: { mcpServers: { svc: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/index.js'], env: { SVC_GONE: 'x', SVC_TOKEN: 'x' } } } } },
    });
    // SVC_FP_DEBUG is only a string literal (an option naming the var), which
    // still counts as read: the dead check wants the name ABSENT from the code.
    expect(codes(fs)).toEqual(['env-dead:SVC_OLD', 'env-dead:SVC_GONE']);
    expect(fs.map((f) => f.file)).toEqual(['manifest.json', '.mcp.json']);
  });

  it('flags a var marked required that the code only reads as optional', () => {
    const fs = envDriftFindings({
      code: code("requireEnvVar('SVC_KEY'); readEnvVar('SVC_REFRESH'); readEnvVar('SVC_BOTH'); requireEnvVar('SVC_BOTH');"),
      manifest: {
        file: 'manifest.json',
        json: {
          server: { mcp_config: { env: { SVC_KEY: '${user_config.key}', SVC_REFRESH: '${user_config.refresh}', SVC_BOTH: '${user_config.both}' } } },
          user_config: { key: { required: true }, refresh: { required: true }, both: { required: true } },
        },
      },
      serverJson: { file: 'server.json', json: { packages: [{ environmentVariables: [
        { name: 'SVC_KEY', isRequired: true }, { name: 'SVC_REFRESH', isRequired: true }, { name: 'SVC_BOTH', isRequired: false },
      ] }] } },
    });
    expect(codes(fs)).toEqual(['env-required-but-optional:SVC_REFRESH', 'env-required-but-optional:SVC_REFRESH']);
    expect(fs[0].message).toMatch(/user_config\.refresh/);
  });

  it('flags a user_config entry nothing passes to the server', () => {
    const fs = envDriftFindings({
      code: code("readEnvVar('SVC_TOKEN');"),
      manifest: { file: 'manifest.json', json: {
        server: { mcp_config: { args: ['--dir=${user_config.dir}'], env: { SVC_TOKEN: '${user_config.token}' } } },
        user_config: { token: {}, dir: {}, link: {} },
      } },
    });
    expect(codes(fs)).toEqual(['user-config-unwired:link']);
  });

  it('ignores library-owned MCP_* knobs and runtime vars in both directions', () => {
    const fs = envDriftFindings({
      code: code("readEnvVar('MCP_CONFIRM_MODE'); readEnvVar('MCP_USER_TZ'); process.env.NODE_ENV; readEnvVar('SVC_TOKEN');"),
      manifest: { file: 'manifest.json', json: { server: { mcp_config: { env: { SVC_TOKEN: 'x', MCP_DATA_DIR: 'x', NODE_OPTIONS: 'x' } } } } },
    });
    expect(fs).toEqual([]);
  });

  it('skips a server.json with no packages (a remote-only listing)', () => {
    const fs = envDriftFindings({
      code: code("readEnvVar('SVC_TOKEN');"),
      serverJson: { file: 'server.json', json: { remotes: [{ type: 'streamable-http', url: 'https://x' }] } },
    });
    expect(fs).toEqual([]);
  });
});

describe('mcpJsonPathFindings', () => {
  it('flags a cwd-relative script path, and passes anchored, absolute and package args', () => {
    const fs = mcpJsonPathFindings({ file: '.mcp.json', json: { mcpServers: {
      rel: { command: 'node', args: ['dist/index.js'] },
      dot: { command: 'node', args: ['./build/server.mjs', '--flag'] },
      anchored: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/index.js'] },
      abs: { command: 'node', args: ['/opt/svc/dist/index.js'] },
      npx: { command: 'npx', args: ['-y', '@chrischall/svc-mcp'] },
      relcmd: { command: './bin/svc' },
    } } });
    expect(codes(fs)).toEqual([
      'mcp-json-relative-path:rel',
      'mcp-json-relative-path:dot',
      'mcp-json-relative-path:relcmd',
    ]);
    expect(fs[0].message).toContain('dist/index.js');
    expect(fs[0].message).toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('tolerates a .mcp.json without mcpServers', () => {
    expect(mcpJsonPathFindings({ file: '.mcp.json', json: {} })).toEqual([]);
  });
});

describe('formatWarning', () => {
  it('emits a GitHub ::warning:: annotation, with file= when the finding has one', () => {
    expect(formatWarning({ message: 'plain' })).toBe('::warning::plain');
    expect(formatWarning({ file: 'manifest.json', message: 'x' })).toBe('::warning file=manifest.json::x');
  });

  it('escapes the characters the annotation syntax reserves', () => {
    expect(formatWarning({ file: 'a,b:c.json', message: '50%\nnext' })).toBe('::warning file=a%2Cb%3Ac.json::50%25%0Anext');
  });
});

describe('findPackageDir / loadSurface', () => {
  let root;
  const write = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  };
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  it('walks up from the entry to the nearest package.json', () => {
    root = mkdtempSync(join(tmpdir(), 'surface-'));
    write('packages/svc/package.json', {});
    write('packages/svc/dist/bin/index.js', '');
    expect(findPackageDir(join(root, 'packages/svc/dist/bin/index.js'))).toBe(join(root, 'packages/svc'));
  });

  it('loads the built source under the entry dir and the config surfaces beside package.json', () => {
    root = mkdtempSync(join(tmpdir(), 'surface-'));
    write('package.json', {});
    write('manifest.json', { tools: [] });
    write('server.json', { packages: [] });
    write('.mcp.json', { mcpServers: {} });
    write('dist/index.js', "import './config.js';");
    write('dist/config.js', "readEnvVar('SVC_A');");
    write('dist/config.js.map', "readEnvVar('SVC_FROM_MAP');");
    write('dist/node_modules/x/index.js', "readEnvVar('SVC_VENDORED');");
    const s = loadSurface(join(root, 'dist/index.js'), root);
    expect([...s.code.reads.keys()]).toEqual(['SVC_A']);
    expect(s.manifest.file).toBe('manifest.json');
    expect(s.serverJson.file).toBe('server.json');
    expect(s.mcpJson.file).toBe('.mcp.json');
  });

  it('returns no surfaces when none sit beside package.json, and reports unparseable JSON', () => {
    root = mkdtempSync(join(tmpdir(), 'surface-'));
    write('package.json', {});
    write('dist/index.js', '');
    expect(loadSurface(join(root, 'dist/index.js'), root)).toMatchObject({ manifest: undefined, serverJson: undefined, mcpJson: undefined, errors: [] });
    write('manifest.json', '{ not json');
    const s = loadSurface(join(root, 'dist/index.js'), root);
    expect(s.manifest).toBeUndefined();
    expect(s.errors).toEqual([expect.objectContaining({ code: 'unreadable-json', file: 'manifest.json' })]);
  });

  it('skips a dangling symlink and a symlink to a directory with a warning instead of throwing', () => {
    root = mkdtempSync(join(tmpdir(), 'surface-'));
    write('package.json', {});
    write('dist/index.js', "readEnvVar('SVC_A');");
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'missing.js'), join(root, 'dist/dangling.js'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'dist/dir-link.js'));
    const s = loadSurface(join(root, 'dist/index.js'), root);
    expect([...s.code.reads.keys()]).toEqual(['SVC_A']);
    expect(s.errors.map((e) => `${e.check}:${e.code}:${e.file}`)).toEqual([
      'surface:unreadable-source:dist/dangling.js',
      'surface:unreadable-source:dist/dir-link.js',
    ]);
  });

  it('does not scan dot-dirs, tests or coverage when the entry sits at the package root', () => {
    root = mkdtempSync(join(tmpdir(), 'surface-'));
    write('package.json', {});
    write('index.js', "readEnvVar('SVC_A');");
    write('lib/config.js', "readEnvVar('SVC_B');");
    write('.git/hooks/x.js', "readEnvVar('SVC_GIT');");
    write('test/setup.js', "readEnvVar('SVC_TEST');");
    write('tests/a.js', "readEnvVar('SVC_TESTS');");
    write('__tests__/a.js', "readEnvVar('SVC_JEST');");
    write('coverage/lcov-report/x.js', "readEnvVar('SVC_COV');");
    write('lib/config.test.js', "readEnvVar('SVC_UNIT');");
    write('lib/config.spec.mjs', "readEnvVar('SVC_SPEC');");
    const s = loadSurface(join(root, 'index.js'), root);
    expect([...s.code.reads.keys()].sort()).toEqual(['SVC_A', 'SVC_B']);
  });
});

describe('env reads from bundled dependencies', () => {
  let root;
  const write = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  };
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
  const manifest = (env) => ({ server: { mcp_config: { env } } });
  // What esbuild inlines from ws, @fetchproxy/server, debug, mime, depd,
  // readable-stream and thread-stream: the fleet-wide false positives.
  const DEP_READS = [
    'process.env.WS_NO_BUFFER_UTIL', 'process.env.WS_NO_UTF_8_VALIDATE',
    "readPortEnv('FETCHPROXY_WS_PORT')", "process.env['FETCHPROXY_WS_HOST']", 'process.env.FETCHPROXY_IDENTITY_DIR',
    'process.env.NODE_V8_COVERAGE', 'process.env.DEBUG_FD', 'process.env.DEBUG_MIME',
    'process.env.NO_DEPRECATION', 'process.env.TRACE_DEPRECATION', 'process.env.READABLE_STREAM',
  ].join(';\n');

  it('attributes reads to the tsc output and ignores the bundle beside it', () => {
    root = mkdtempSync(join(tmpdir(), 'surface-'));
    write('package.json', {});
    write('manifest.json', manifest({ SVC_TOKEN: 'x' }));
    write('dist/index.js', "import './config.js';");
    write('dist/config.js', "requireEnvVar('SVC_TOKEN');");
    write('dist/bundle.js', `requireEnvVar('SVC_TOKEN');\n${DEP_READS};\nreadEnvVar('SVC_BUNDLE_ONLY');`);
    const s = loadSurface(join(root, 'dist/index.js'), root);
    expect([...s.code.reads.keys()]).toEqual(['SVC_TOKEN']);
    expect(envDriftFindings(s)).toEqual([]);
  });

  it('still uses the tsc output when the entry handed to it is the bundle', () => {
    root = mkdtempSync(join(tmpdir(), 'surface-'));
    write('package.json', {});
    write('dist/index.js', "readEnvVar('SVC_A');");
    write('dist/bundle.js', DEP_READS);
    expect([...loadSurface(join(root, 'dist/bundle.js'), root).code.reads.keys()]).toEqual(['SVC_A']);
  });

  it("still warns on an undeclared key the server's own code reads, a dependency's key included", () => {
    root = mkdtempSync(join(tmpdir(), 'surface-'));
    write('package.json', {});
    write('manifest.json', manifest({ SVC_TOKEN: 'x' }));
    write('dist/index.js', "requireEnvVar('SVC_TOKEN'); readEnvVar('SVC_OUTPUT_DIR'); readPortEnv('FETCHPROXY_WS_PORT');");
    write('dist/bundle.js', DEP_READS);
    expect(codes(envDriftFindings(loadSurface(join(root, 'dist/index.js'), root))))
      .toEqual(['env-undeclared:FETCHPROXY_WS_PORT', 'env-undeclared:SVC_OUTPUT_DIR']);
  });

  it('does not call a declared key dead when only a bundled dependency reads it', () => {
    root = mkdtempSync(join(tmpdir(), 'surface-'));
    write('package.json', {});
    write('manifest.json', manifest({ SVC_TOKEN: 'x', FETCHPROXY_WS_PORT: 'x', SVC_OLD: 'x' }));
    write('dist/index.js', "requireEnvVar('SVC_TOKEN');");
    write('dist/bundle.js', DEP_READS);
    expect(codes(envDriftFindings(loadSurface(join(root, 'dist/index.js'), root)))).toEqual(['env-dead:SVC_OLD']);
  });

  it('falls back to the bundle with the dependency ignore list when there is no tsc output', () => {
    root = mkdtempSync(join(tmpdir(), 'surface-'));
    write('package.json', {});
    write('manifest.json', manifest({ SVC_TOKEN: 'x' }));
    write('dist/bundle.js', `requireEnvVar('SVC_TOKEN');\n${DEP_READS};\nreadEnvVar('SVC_OUTPUT_DIR');\nprocess.env.WS_NO_SOMETHING_NEW;\nprocess.env.FETCHPROXY_NEW_KNOB;`);
    const s = loadSurface(join(root, 'dist/bundle.js'), root);
    expect(s.code.bundled).toBe(true);
    // The server's own undeclared read is still caught in the bundle.
    expect(codes(envDriftFindings(s))).toEqual(['env-undeclared:SVC_OUTPUT_DIR']);
  });

  it('reports dependency keys from own (unbundled) code but drops them from a bundle', () => {
    const src = 'process.env.WS_NO_BUFFER_UTIL; process.env.FETCHPROXY_WS_HOST; process.env.DEBUG_FD; process.env.NODE_V8_COVERAGE;';
    const m = { file: 'manifest.json', json: manifest({}) };
    expect(codes(envDriftFindings({ code: { text: src, reads: collectEnvReads(src) }, manifest: m })))
      .toEqual(['env-undeclared:DEBUG_FD', 'env-undeclared:FETCHPROXY_WS_HOST', 'env-undeclared:WS_NO_BUFFER_UTIL']);
    expect(envDriftFindings({ code: { text: src, reads: collectEnvReads(src), bundled: true }, manifest: m })).toEqual([]);
  });
});

describe('collectSurfaceWarnings', () => {
  it('turns a surface-check crash into one surface warning instead of throwing', () => {
    const boom = () => { throw new Error('EACCES: permission denied'); };
    const ws = collectSurfaceWarnings('dist/index.js', [], { load: boom });
    expect(ws).toEqual([expect.objectContaining({ check: 'surface', code: 'surface-check-failed' })]);
    expect(ws[0].message).toMatch(/EACCES: permission denied/);
  });

  it('collects every check for a loaded surface', () => {
    const load = () => ({ code: { text: '', reads: new Map() }, manifest: undefined, serverJson: undefined, mcpJson: undefined, errors: [] });
    const ws = collectSurfaceWarnings('dist/index.js', [{ name: 'svc_send', annotations: { readOnlyHint: false } }], { load });
    expect(ws.map((w) => w.code).sort()).toEqual(['destructive-implicit', 'open-world-missing']);
  });
});

// Which file the `${CLAUDE_PLUGIN_ROOT}` anchor rule applies to. Claude Code
// defines CLAUDE_PLUGIN_ROOT for a PLUGIN launch only; a project-scoped
// `.mcp.json` launched with it runs `node /dist/...` and dies at startup
// (office-outlook-mcp's tests/server-boot.test.ts; tempo-api-mcp regressed by
// following the old lint). So the rule follows the config the plugin uses.
describe('plugin MCP config layouts', () => {
  let root;
  const write = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  };
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  const REL = { command: 'node', args: ['dist/index.js'] };
  const ANCHORED = { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/index.js'] };
  const NPX = { command: 'npx', args: ['-y', 'svc-mcp'] };
  const MCP_CODES = new Set([
    'mcp-json-relative-path', 'mcp-json-plugin-root-in-project-config',
    'plugin-json-mcp-ignored', 'plugin-mcp-config-missing',
  ]);
  /** Lay out a repo and return its mcp-config findings as `code:subject@file`. */
  const run = ({ plugin, rootMcp, files = {} }) => {
    root = mkdtempSync(join(tmpdir(), 'surface-'));
    write('package.json', {});
    write('dist/index.js', '');
    if (plugin !== undefined) write('.claude-plugin/plugin.json', { name: 'svc', ...plugin });
    if (rootMcp !== undefined) write('.mcp.json', { mcpServers: rootMcp });
    for (const [rel, body] of Object.entries(files)) write(rel, body);
    const ws = collectSurfaceWarnings(join(root, 'dist/index.js'), [], { load: (e) => loadSurface(e, root) });
    return ws.filter((w) => MCP_CODES.has(w.code));
  };
  const ids = (fs) => fs.map((f) => `${f.code}:${f.subject}@${f.file}`);

  describe('mcpServers: "./.mcp.json" (the root file IS the plugin config)', () => {
    it('warns on a cwd-relative path in it', () => {
      expect(ids(run({ plugin: { mcpServers: './.mcp.json' }, rootMcp: { svc: REL } })))
        .toEqual(['mcp-json-relative-path:svc@.mcp.json']);
    });
    it('is clean when anchored', () => {
      expect(run({ plugin: { mcpServers: './.mcp.json' }, rootMcp: { svc: ANCHORED } })).toEqual([]);
    });
  });

  describe('no mcpServers field (Claude Code defaults to the root .mcp.json)', () => {
    it('warns on a cwd-relative path in the root file', () => {
      expect(ids(run({ plugin: {}, rootMcp: { svc: REL } }))).toEqual(['mcp-json-relative-path:svc@.mcp.json']);
    });
    it('is clean when anchored', () => {
      expect(run({ plugin: {}, rootMcp: { svc: ANCHORED } })).toEqual([]);
    });
    it('keeps the old behaviour with no plugin.json at all', () => {
      expect(ids(run({ rootMcp: { svc: REL } }))).toEqual(['mcp-json-relative-path:svc@.mcp.json']);
    });
  });

  describe('mcpServers naming a separate file (resolved against the plugin root)', () => {
    const plugin = { mcpServers: './.claude-plugin/mcp.json' };
    it('warns on a cwd-relative path in the plugin config', () => {
      expect(ids(run({ plugin, rootMcp: { svc: REL }, files: { '.claude-plugin/mcp.json': { mcpServers: { svc: REL } } } })))
        .toEqual(['mcp-json-relative-path:svc@.claude-plugin/mcp.json']);
    });
    it('is clean with an anchored plugin config and a relative project-scoped root .mcp.json', () => {
      expect(run({ plugin, rootMcp: { svc: REL }, files: { '.claude-plugin/mcp.json': { mcpServers: { svc: ANCHORED } } } }))
        .toEqual([]);
    });
    it('warns when the project-scoped root .mcp.json uses ${CLAUDE_PLUGIN_ROOT}, and says why', () => {
      const fs = run({ plugin, rootMcp: { svc: ANCHORED }, files: { '.claude-plugin/mcp.json': { mcpServers: { svc: ANCHORED } } } });
      expect(ids(fs)).toEqual(['mcp-json-plugin-root-in-project-config:svc@.mcp.json']);
      expect(fs[0].message).toMatch(/only for a plugin/);
      expect(fs[0].message).toMatch(/project-scoped/);
      expect(fs[0].message).toContain('/dist/index.js');
    });
    it('warns when the named file does not exist', () => {
      expect(ids(run({ plugin: { mcpServers: './mcp.json' }, rootMcp: { svc: REL } })))
        .toEqual(['plugin-mcp-config-missing:./mcp.json@.claude-plugin/plugin.json']);
    });
  });

  describe('the fleet\'s `"mcp": "./mcp.json"` (a key Claude Code ignores)', () => {
    it('reports the ignored key and the unresolvable path, and treats the root file as project-scoped', () => {
      const fs = run({
        plugin: { mcp: './mcp.json' }, rootMcp: { svc: REL },
        files: { '.claude-plugin/mcp.json': { mcpServers: { svc: ANCHORED } } },
      });
      expect(ids(fs)).toEqual([
        'plugin-json-mcp-ignored:mcp@.claude-plugin/plugin.json',
        'plugin-mcp-config-missing:./mcp.json@.claude-plugin/plugin.json',
      ]);
      expect(fs[0].message).toContain('"mcpServers": "./.claude-plugin/mcp.json"');
    });
  });

  describe('inline mcpServers object in plugin.json', () => {
    it('warns on a cwd-relative path inline', () => {
      expect(ids(run({ plugin: { mcpServers: { svc: REL } }, rootMcp: { svc: REL } })))
        .toEqual(['mcp-json-relative-path:svc@.claude-plugin/plugin.json']);
    });
    it('is clean with a package launch inline and a relative project-scoped root .mcp.json', () => {
      expect(run({ plugin: { mcpServers: { svc: NPX } }, rootMcp: { 'svc-dev': REL } })).toEqual([]);
    });
    it('warns when the project-scoped root .mcp.json uses ${CLAUDE_PLUGIN_ROOT}', () => {
      expect(ids(run({ plugin: { mcpServers: { svc: NPX } }, rootMcp: { svc: ANCHORED } })))
        .toEqual(['mcp-json-plugin-root-in-project-config:svc@.mcp.json']);
    });
  });

  describe('an array of shapes', () => {
    it('treats the root file as plugin config when the array names it, and checks inline entries and skips bundles', () => {
      const fs = run({
        plugin: { mcpServers: ['./.mcp.json', { extra: REL }, './svc.mcpb', 'https://example.com/svc.mcpb'] },
        rootMcp: { svc: REL },
      });
      expect(ids(fs)).toEqual([
        'mcp-json-relative-path:svc@.mcp.json',
        'mcp-json-relative-path:extra@.claude-plugin/plugin.json',
      ]);
    });
  });
});

describe('an ignored "mcp" key that names the default', () => {
  it('is not reported: Claude Code loads the root .mcp.json anyway, which is what it names', () => {
    const fs = mcpConfigPathFindings({
      mcpJson: { file: '.mcp.json', json: { mcpServers: { svc: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/index.js'] } } } },
      pluginMcp: resolvePluginMcp({ file: '.claude-plugin/plugin.json', json: { mcp: './.mcp.json' } }, () => null, (rel) => rel === './.mcp.json'),
    });
    expect(fs).toEqual([]);
  });
});
