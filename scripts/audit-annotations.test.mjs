// The CLI chrischall/workflows' reusable-mcp-ci.yml runs against every built
// server: serve it over stdio, print each tool, exit non-zero on a confirm
// boolean or an --expect mismatch. The surface checks (clusters 2, 3, 9 of
// the 2026-10 low-severity sweep) only WARN unless --strict, so a fleet repo
// that passed before still passes.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'audit-annotations.mjs');
const FIXTURE = join(HERE, 'fixtures', 'tools-server.mjs');

const READ = { readOnlyHint: true, openWorldHint: true };
const ADDITIVE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

let root;
/** A fake package: dist/index.js boots the fixture; `files` adds config and source. */
const pkg = (files = {}) => {
  root = mkdtempSync(join(tmpdir(), 'audit-annotations-'));
  const all = {
    'package.json': '{"name":"svc-mcp"}',
    'dist/index.js': `import ${JSON.stringify(FIXTURE)};\n`,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
};
const run = (tools, ...args) => spawnSync(process.execPath, [CLI, 'dist/index.js', ...args], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, FIXTURE_TOOLS: JSON.stringify(tools) },
  timeout: 30_000,
});
const warnings = (r) => r.stdout.split('\n').filter((l) => l.startsWith('::warning'));

afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

describe('audit-annotations.mjs', () => {
  it('keeps the per-tool lines CI parses, and exits 0 on a clean server', () => {
    pkg();
    const r = run([{ name: 'svc_list', annotations: READ }, { name: 'svc_fav', annotations: ADDITIVE }]);
    expect(r.status).toBe(0);
    // reusable-mcp-ci.yml: sed -nE 's/^  (read|additive|DESTRUCTIVE) +([^ ]+).*/\2/p'
    expect(r.stdout).toMatch(/^ {2}additive {4}svc_fav/m);
    expect(r.stdout).toMatch(/^ {2}read {8}svc_list/m);
    expect(warnings(r)).toEqual([]);
  });

  it('warns on implicit destructiveHint and missing openWorldHint, but still exits 0', () => {
    pkg();
    const r = run([{ name: 'svc_send', annotations: { readOnlyHint: false } }]);
    expect(r.status).toBe(0);
    expect(warnings(r)).toEqual([
      expect.stringMatching(/^::warning::svc_send: not read-only and destructiveHint is not set/),
      expect.stringMatching(/^::warning::svc_send: no openWorldHint/),
    ]);
    expect(r.stdout).toMatch(/surface checks {3}annotations 2 {3}manifest-tools 0 {3}env 0/);
  });

  it('--strict turns any warning into exit 1', () => {
    pkg();
    const r = run([{ name: 'svc_send', annotations: { readOnlyHint: false } }], '--strict');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--strict/);
    pkg();
    expect(run([{ name: 'svc_list', annotations: READ }], '--strict').status).toBe(0);
  });

  it('warns on manifest.json tools[] drift in both directions, with file=', () => {
    pkg({ 'manifest.json': { tools: [{ name: 'svc_list' }, { name: 'svc_old' }] } });
    const r = run([{ name: 'svc_list', annotations: READ }, { name: 'svc_new', annotations: READ }]);
    expect(r.status).toBe(0);
    expect(warnings(r)).toEqual([
      expect.stringMatching(/^::warning file=manifest\.json::svc_new is served but missing/),
      expect.stringMatching(/^::warning file=manifest\.json::svc_old is listed .* but the server does not serve it/),
    ]);
  });

  it('warns on env drift and a relative .mcp.json path', () => {
    pkg({
      'dist/config.js': "export const cfg = () => [readEnvVar('SVC_TOKEN'), readEnvVar('SVC_DIR')];\n",
      'manifest.json': {
        server: { mcp_config: { env: { SVC_TOKEN: '${user_config.token}', SVC_DEAD: 'x' } } },
        user_config: { token: { type: 'string', required: true } },
      },
      '.mcp.json': { mcpServers: { svc: { command: 'node', args: ['dist/index.js'] } } },
    });
    const r = run([{ name: 'svc_list', annotations: READ }]);
    expect(r.status).toBe(0);
    const w = warnings(r);
    expect(w).toContainEqual(expect.stringMatching(/^::warning file=manifest\.json::SVC_DIR is read by the server but not declared/));
    expect(w).toContainEqual(expect.stringMatching(/^::warning file=manifest\.json::SVC_DEAD is declared .* never reads it/));
    expect(w).toContainEqual(expect.stringMatching(/^::warning file=manifest\.json::SVC_TOKEN is marked required .*user_config\.token/));
    expect(w).toContainEqual(expect.stringMatching(/^::warning file=\.mcp\.json::\.mcp\.json server "svc" runs dist\/index\.js relative/));
    expect(w).toHaveLength(4);
  });

  it('leaves the confirm-boolean ERROR and the --expect mismatch exit codes as they were', () => {
    pkg();
    const confirm = run([{ name: 'svc_pay', annotations: ADDITIVE, confirm: true }]);
    expect(confirm.status).toBe(1);
    expect(confirm.stderr).toMatch(/svc_pay take a boolean `confirm` input/);
    const expectBad = run([{ name: 'svc_list', annotations: READ }], '--expect', '2');
    expect(expectBad.status).toBe(1);
    expect(expectBad.stderr).toMatch(/MISMATCH: served 1, expected 2/);
  });

  it('a dangling .js symlink in dist/ is a warning, not a crash, and still exits 0', () => {
    pkg();
    symlinkSync(join(root, 'nowhere.js'), join(root, 'dist/dangling.js'));
    const r = run([{ name: 'svc_list', annotations: READ }]);
    expect(r.stderr).not.toMatch(/ENOENT/);
    expect(r.status).toBe(0);
    expect(warnings(r)).toEqual([expect.stringMatching(/^::warning file=dist\/dangling\.js::.*could not be read/)]);
    expect(run([{ name: 'svc_list', annotations: READ }], '--strict').status).toBe(1);
  });

  it('--summary still prints the warnings, without the per-tool list', () => {
    pkg();
    const r = run([{ name: 'svc_send', annotations: { readOnlyHint: false } }], '--summary');
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/^ {2}DESTRUCTIVE/m);
    expect(warnings(r)).toHaveLength(2);
  });
});
