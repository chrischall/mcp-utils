/**
 * Warn-only checks on what a built MCP server publishes and how it is
 * configured, run by audit-annotations.mjs beside the confirm-gate lint
 * (chrischall/workflows reusable-mcp-ci.yml serves every built server and
 * prints this script's output, so a `::warning::` line here becomes a PR
 * annotation in every fleet repo).
 *
 * Each is a cluster from the 2026-10 sweep of open sev:low fleet-audit
 * findings that one shared lint retires instead of one PR per repo:
 *
 * - **annotations** (cluster 2, 24 repos): a non-read tool whose
 *   `destructiveHint` is not an explicit boolean — the spec defaults it to
 *   TRUE, so silence publishes "add a grocery item" with the same alarm as
 *   "delete the frame" — and any tool with no explicit `openWorldHint`.
 *   Local-only tools (calculators, `*_session_status`) answer the second by
 *   declaring `openWorld: false`, not by being skipped.
 * - **manifest-tools** (cluster 3, 17 repos): `manifest.json` `tools[]` names
 *   vs the SERVED `tools/list`, both directions (skylight listed 22 of 113).
 *   `tools_generated: true` declares the list partial, so only stale entries
 *   are reported then. Nothing checked this before: `versionSyncTest` syncs
 *   versions only and mcp-publish packs the manifest as-is.
 * - **env** (cluster 9, 9 repos): env keys the BUILT code reads vs what
 *   `manifest.json` (`server.mcp_config.env` + `user_config`), `server.json`
 *   (`packages[].environmentVariables`) and `.mcp.json` declare — undeclared
 *   reads, dead declarations, a var marked required that the code only reads
 *   optionally (freshbooks' refresh token, tripadvisor's API key), a
 *   `user_config` entry nothing passes to the server, and a cwd-relative
 *   script path in `.mcp.json` (ioffice).
 *
 * Why the built code and not src/: it is what ships, and a bundle carries
 * every literal key a src/ grep would find. Only LITERAL keys are visible —
 * `readEnvVar(\`${PREFIX}_TOKEN\`)` is not — and a var documented only in a
 * README is invisible too (SKILL.md), which is why every check here WARNS and
 * only `--strict` turns them into a failure.
 *
 * Node built-ins only: CI copies scripts/ into a directory that has nothing
 * installed but @modelcontextprotocol/client.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * @typedef {{
 *   check: 'annotations' | 'manifest-tools' | 'env' | 'surface',
 *   code: string,
 *   subject: string,
 *   message: string,
 *   file?: string,
 * }} SurfaceFinding
 */

// ---------------------------------------------------------------------------
// annotations
// ---------------------------------------------------------------------------

/**
 * Hint findings for a served tool list, sorted by tool name.
 * @param {{ name: string, annotations?: Record<string, unknown> }[]} tools
 * @returns {SurfaceFinding[]}
 */
export function annotationHintFindings(tools) {
  const out = [];
  for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const a = t.annotations ?? {};
    if (a.readOnlyHint !== true && typeof a.destructiveHint !== 'boolean') {
      out.push({
        check: 'annotations', code: 'destructive-implicit', subject: t.name,
        message: `${t.name}: not read-only and destructiveHint is not set, so it defaults to true and the tool is published as DESTRUCTIVE. `
          + 'Say which it is: toolAnnotations({ readOnly: false, destructive: false }) for a write the owner can undo, destructive: true for a delete, a send, or anything another person sees.',
      });
    }
    if (typeof a.openWorldHint !== 'boolean') {
      out.push({
        check: 'annotations', code: 'open-world-missing', subject: t.name,
        message: `${t.name}: no openWorldHint. Pass openWorld: true for a tool that reaches the network, openWorld: false for a local-only one.`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// manifest tools[]
// ---------------------------------------------------------------------------

/**
 * `manifest.json` `tools[]` vs the served names. Missing (served, not listed)
 * first, then stale (listed, not served), each sorted.
 * @param {any} manifest parsed manifest.json
 * @param {string[]} servedNames
 * @param {string} file path to report
 * @returns {SurfaceFinding[]}
 */
export function manifestToolDriftFindings(manifest, servedNames, file) {
  if (!Array.isArray(manifest?.tools)) return [];
  const listed = new Set(manifest.tools.map((t) => t?.name).filter((n) => typeof n === 'string'));
  const served = new Set(servedNames);
  const out = [];
  if (manifest.tools_generated !== true) {
    for (const name of [...served].filter((n) => !listed.has(n)).sort()) {
      out.push({
        check: 'manifest-tools', code: 'manifest-missing-tool', subject: name, file,
        message: `${name} is served but missing from ${file} tools[] — the .mcpb listing under-reports what the server does.`,
      });
    }
  }
  for (const name of [...listed].filter((n) => !served.has(n)).sort()) {
    out.push({
      check: 'manifest-tools', code: 'manifest-stale-tool', subject: name, file,
      message: `${name} is listed in ${file} tools[] but the server does not serve it (renamed, removed, or registered only once configured).`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

const KEY = '[A-Z_][A-Z0-9_]*';
const Q = '[\'"`]';
// A trailing digit run covers esbuild's de-duplicated names (`readEnvVar2`).
const OPTIONAL_READERS = new RegExp(`\\b(?:readEnvVar|parseBoolEnv|readPortEnv|readIntEnv|readTtlMsEnv)\\d*\\s*\\(\\s*${Q}(${KEY})${Q}`, 'g');
const REQUIRED_READERS = new RegExp(`\\brequireEnvVar\\d*\\s*\\(\\s*${Q}(${KEY})${Q}`, 'g');
const PROCESS_ENV = new RegExp(`\\bprocess\\.env(?:\\.(${KEY})\\b|\\[\\s*${Q}(${KEY})${Q}\\s*\\])`, 'g');

/**
 * Literal env keys the code reads, and how.
 * @param {string} text built source
 * @returns {Map<string, { required: boolean, optional: boolean }>}
 */
export function collectEnvReads(text) {
  const reads = new Map();
  const mark = (key, kind) => {
    const r = reads.get(key) ?? { required: false, optional: false };
    r[kind] = true;
    reads.set(key, r);
  };
  for (const m of text.matchAll(OPTIONAL_READERS)) mark(m[1], 'optional');
  for (const m of text.matchAll(REQUIRED_READERS)) mark(m[1], 'required');
  for (const m of text.matchAll(PROCESS_ENV)) mark(m[1] ?? m[2], 'optional');
  return reads;
}

/**
 * Keys no server owns: `MCP_*` are mcp-utils' fleet-wide knobs (confirm mode,
 * data dir, user time zone), read inside the library — present in a bundle,
 * absent from an unbundled build — and the rest belong to the runtime.
 */
const isIgnoredKey = (k) => k.startsWith('MCP_') || RUNTIME_KEYS.has(k);
const RUNTIME_KEYS = new Set([
  'NODE_ENV', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'DEBUG',
  'HOME', 'PATH', 'TZ', 'TMPDIR', 'USER', 'LANG', 'CI', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'CLAUDE_PLUGIN_ROOT',
]);

const USER_CONFIG_REF = /\$\{user_config\.([^}]+)\}/g;
const userConfigRefs = (value) => [...String(value ?? '').matchAll(USER_CONFIG_REF)].map((m) => m[1]);

/** @returns {{ name: string, required: boolean, via?: string }[]} */
function manifestDecls(json) {
  const env = json?.server?.mcp_config?.env ?? {};
  const uc = json?.user_config ?? {};
  return Object.entries(env).map(([name, value]) => {
    const via = userConfigRefs(value).find((k) => uc[k]?.required === true);
    return { name, required: via !== undefined, ...(via ? { via: `user_config.${via}` } : {}) };
  });
}

function serverJsonDecls(json) {
  const out = [];
  for (const p of json?.packages ?? []) {
    for (const v of p?.environmentVariables ?? []) {
      if (typeof v?.name === 'string') out.push({ name: v.name, required: v.isRequired === true });
    }
  }
  return out;
}

function mcpJsonDecls(json) {
  const out = [];
  for (const s of Object.values(json?.mcpServers ?? {})) {
    for (const name of Object.keys(s?.env ?? {})) out.push({ name, required: false });
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, key) => {
  const k = escapeRe(key);
  return new RegExp(`${Q}${k}${Q}|\\bprocess\\.env\\.${k}\\b`).test(text);
};

/**
 * Env drift between the built code and each config surface present.
 * Per surface: undeclared reads (manifest.json and server.json only — a
 * dev-only `.mcp.json` legitimately leans on `.env`), dead declarations,
 * then required-but-optional; `user_config` entries nothing wires last.
 * @param {{
 *   code: { text: string, reads: Map<string, { required: boolean, optional: boolean }> },
 *   manifest?: { file: string, json: any },
 *   serverJson?: { file: string, json: any },
 *   mcpJson?: { file: string, json: any },
 * }} s
 * @returns {SurfaceFinding[]}
 */
export function envDriftFindings({ code, manifest, serverJson, mcpJson }) {
  const out = [];
  const read = [...code.reads.keys()].filter((k) => !isIgnoredKey(k)).sort();
  const surfaces = [
    manifest && { ...manifest, decls: manifestDecls(manifest.json), where: 'server.mcp_config.env', checkUndeclared: true },
    serverJson && Array.isArray(serverJson.json?.packages)
      && { ...serverJson, decls: serverJsonDecls(serverJson.json), where: 'packages[].environmentVariables', checkUndeclared: true },
    mcpJson && { ...mcpJson, decls: mcpJsonDecls(mcpJson.json), where: 'mcpServers.*.env', checkUndeclared: false },
  ].filter(Boolean);

  for (const s of surfaces) {
    const declared = new Set(s.decls.map((d) => d.name));
    if (s.checkUndeclared) {
      for (const k of read.filter((k) => !declared.has(k))) {
        out.push({
          check: 'env', code: 'env-undeclared', subject: k, file: s.file,
          message: `${k} is read by the server but not declared in ${s.file} ${s.where}, so a user of that install path cannot set it.`,
        });
      }
    }
    for (const d of s.decls) {
      if (isIgnoredKey(d.name) || mentions(code.text, d.name)) continue;
      out.push({
        check: 'env', code: 'env-dead', subject: d.name, file: s.file,
        message: `${d.name} is declared in ${s.file} ${s.where} but the built server never reads it.`,
      });
    }
    for (const d of s.decls) {
      const r = code.reads.get(d.name);
      if (!d.required || !r || r.required || !r.optional) continue;
      out.push({
        check: 'env', code: 'env-required-but-optional', subject: d.name, file: s.file,
        message: `${d.name} is marked required in ${s.file}${d.via ? ` (${d.via})` : ''} but the server only reads it with an optional reader (readEnvVar / parseBoolEnv / process.env). If the server can run without it, mark it optional so installs are not forced to invent a value; if it cannot, read it with requireEnvVar.`,
      });
    }
  }

  if (manifest) {
    const mc = manifest.json?.server?.mcp_config ?? {};
    const wired = new Set([
      ...Object.values(mc.env ?? {}).flatMap(userConfigRefs),
      ...(Array.isArray(mc.args) ? mc.args : []).flatMap(userConfigRefs),
      ...userConfigRefs(mc.command),
    ]);
    for (const k of Object.keys(manifest.json?.user_config ?? {}).sort()) {
      if (wired.has(k)) continue;
      out.push({
        check: 'env', code: 'user-config-unwired', subject: k, file: manifest.file,
        message: `user_config.${k} in ${manifest.file} is asked of the user but never passed to the server (no \${user_config.${k}} in server.mcp_config).`,
      });
    }
  }
  return out;
}

const SCRIPT_PATH = /\.(?:c|m)?[jt]s$/;
const isRelativePath = (p) =>
  typeof p === 'string' && !p.startsWith('${') && !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p)
  && (p.startsWith('./') || p.startsWith('../') || (SCRIPT_PATH.test(p) && !p.startsWith('-') && !p.startsWith('@')));

/**
 * `.mcp.json` command/args that resolve against the CLIENT's cwd rather than
 * the plugin: they work from the repo root and nowhere else.
 * @param {{ file: string, json: any }} mcpJson
 * @returns {SurfaceFinding[]}
 */
export function mcpJsonPathFindings({ file, json }) {
  const out = [];
  for (const [name, s] of Object.entries(json?.mcpServers ?? {})) {
    const bad = [s?.command, ...(Array.isArray(s?.args) ? s.args : [])].filter(isRelativePath);
    if (!bad.length) continue;
    out.push({
      check: 'env', code: 'mcp-json-relative-path', subject: name, file,
      message: `${file} server "${name}" runs ${bad.join(', ')} relative to the client's working directory; anchor it as \${CLAUDE_PLUGIN_ROOT}/… so it works from any cwd.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** One finding as a GitHub Actions `::warning::` workflow command. */
export function formatWarning(f) {
  return `::warning${f.file ? ` file=${escapeProperty(f.file)}` : ''}::${escapeData(f.message)}`;
}

/** The nearest ancestor of `entry` holding a package.json (or `entry`'s own dir). */
export function findPackageDir(entry) {
  const start = dirname(resolve(entry));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

const SOURCE_EXT = /\.(?:c|m)?js$/;
function readBuiltSource(dir) {
  const parts = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (SOURCE_EXT.test(e.name)) parts.push(readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return parts.join('\n');
}

/**
 * Everything the surface checks read: the built source (every .js/.mjs/.cjs
 * under the entry's directory, node_modules skipped) and each config file
 * present beside the entry's package.json. File paths are reported relative
 * to `cwd`, which is the repo root in CI.
 * @param {string} entry
 * @param {string} [cwd]
 */
export function loadSurface(entry, cwd = process.cwd()) {
  const pkgDir = findPackageDir(entry);
  const entryDir = dirname(resolve(entry));
  const text = statSync(entryDir).isDirectory() ? readBuiltSource(entryDir) : '';
  const errors = [];
  const load = (name) => {
    const p = join(pkgDir, name);
    if (!existsSync(p)) return undefined;
    const file = relative(cwd, p) || name;
    try {
      return { file, json: JSON.parse(readFileSync(p, 'utf8')) };
    } catch (e) {
      errors.push({ check: 'surface', code: 'unreadable-json', subject: name, file, message: `${file} is not valid JSON (${e.message}), so it was not checked.` });
      return undefined;
    }
  };
  return {
    code: { text, reads: collectEnvReads(text) },
    manifest: load('manifest.json'),
    serverJson: load('server.json'),
    mcpJson: load('.mcp.json'),
    errors,
  };
}
