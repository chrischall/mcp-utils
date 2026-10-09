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
 *   script path in the plugin's MCP config (ioffice). That last rule follows
 *   the config the plugin actually uses (`.claude-plugin/plugin.json`
 *   `mcpServers`; the root `.mcp.json` when absent): a root `.mcp.json` that
 *   is NOT the plugin config is project-scoped, where CLAUDE_PLUGIN_ROOT is
 *   undefined, so there it warns on `${CLAUDE_PLUGIN_ROOT}` instead
 *   (office-outlook-mcp; tempo-api-mcp). Any plugin.json `mcp` key, a key
 *   Claude Code ignores, is reported too — `"mcp": "./.mcp.json"` (57 repos)
 *   with a softer message, since it names the default. See
 *   `mcpConfigPathFindings`.
 *
 * Why the built code and not src/: it is what ships. Which built code: the
 * SERVER's own. Reads are attributed to the tsc output (every built file
 * except an esbuild `bundle.js`) whenever it exists, because a bundle also
 * inlines every dependency, and their env reads are not server config — the
 * 2026-10 fleet run reported `ws`'s WS_NO_BUFFER_UTIL (×21) and
 * WS_NO_UTF_8_VALIDATE (×18), @fetchproxy/server's FETCHPROXY_WS_PORT /
 * _WS_HOST / _IDENTITY_DIR (×16/×9/×9) and debug/mime/depd/readable-stream/
 * thread-stream keys as undeclared, and two repos hid them with esbuild
 * `--define`. Only when a bundle is ALL there is does the check fall back to
 * it, minus a list of those well-known dependency keys (DEPENDENCY_KEYS). A
 * server that reads one of them in its own code is still checked, because
 * the tsc output wins whenever it is present. The dead-declaration check
 * still searches the bundle too: a declared knob that only a dependency reads
 * is live. Only LITERAL keys are visible —
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
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'CLAUDE_PLUGIN_ROOT', 'NODE_V8_COVERAGE',
]);

/**
 * Keys that bundled third-party dependencies read, dropped from reads ONLY
 * when the bundle is the sole built source (`code.bundled`). With tsc output
 * present the bundle is not scanned for reads at all, so a server that reads
 * one of these itself must still declare it. Measured across 67 fleet repos
 * (2026-10): `ws` (WS_NO_BUFFER_UTIL, WS_NO_UTF_8_VALIDATE → the `WS_NO_`
 * prefix), @fetchproxy/server's hosting knobs (inert when the server passes
 * an explicit port → the `FETCHPROXY_` prefix), debug (DEBUG_FD), mime
 * (DEBUG_MIME), depd (NO_DEPRECATION, TRACE_DEPRECATION) and readable-stream
 * (READABLE_STREAM). thread-stream's NODE_V8_COVERAGE is a Node runtime var,
 * so it lives in RUNTIME_KEYS.
 */
const DEPENDENCY_KEYS = new Set(['DEBUG_FD', 'DEBUG_MIME', 'NO_DEPRECATION', 'TRACE_DEPRECATION', 'READABLE_STREAM']);
const DEPENDENCY_PREFIXES = ['WS_NO_', 'FETCHPROXY_'];
const isDependencyKey = (k) => DEPENDENCY_KEYS.has(k) || DEPENDENCY_PREFIXES.some((p) => k.startsWith(p));

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
 * `code.reads` are the server's own reads; `code.text` is everything shipped
 * (bundle included) and only answers "is this declared key mentioned at all".
 * `code.bundled` says the reads came from a bundle, so DEPENDENCY_KEYS drop.
 * @param {{
 *   code: { text: string, reads: Map<string, { required: boolean, optional: boolean }>, bundled?: boolean },
 *   manifest?: { file: string, json: any },
 *   serverJson?: { file: string, json: any },
 *   mcpJson?: { file: string, json: any },
 * }} s
 * @returns {SurfaceFinding[]}
 */
export function envDriftFindings({ code, manifest, serverJson, mcpJson }) {
  const out = [];
  const read = [...code.reads.keys()]
    .filter((k) => !isIgnoredKey(k) && !(code.bundled && isDependencyKey(k)))
    .sort();
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
 * MCP config command/args that resolve against the CLIENT's cwd rather than
 * the plugin: they work from the repo root and nowhere else. Apply this ONLY
 * to a config the plugin loads (see `mcpConfigPathFindings`) — the fix it
 * suggests, `${CLAUDE_PLUGIN_ROOT}`, is undefined for a project-scoped
 * `.mcp.json`.
 * @param {{ file: string, json: any }} config
 * @returns {SurfaceFinding[]}
 */
export function mcpJsonPathFindings({ file, json }) {
  const out = [];
  for (const [name, s] of Object.entries(json?.mcpServers ?? {})) {
    const bad = [s?.command, ...(Array.isArray(s?.args) ? s.args : [])].filter(isRelativePath);
    if (!bad.length) continue;
    out.push({
      check: 'env', code: 'mcp-json-relative-path', subject: name, file,
      message: `${file} server "${name}" runs ${bad.join(', ')} relative to the client's working directory; this is the plugin's MCP config, so anchor it as \${CLAUDE_PLUGIN_ROOT}/… so it works from any cwd.`,
    });
  }
  return out;
}

const BUNDLE_OR_URL = /^https?:\/\/|\.(?:mcpb|dxt)$/i;

/**
 * Which MCP config a Claude Code plugin install uses, from
 * `.claude-plugin/plugin.json` `mcpServers` (Claude Code's plugin manifest
 * reference, verified with `claude plugin validate` 2.1.295):
 *
 * - **no field**: the default, `.mcp.json` at the plugin root — the root file
 *   IS the plugin config (`rootIsPluginConfig`);
 * - **a path** (or an array holding paths): resolved against the plugin root
 *   (the directory holding `.claude-plugin/`, not `.claude-plugin/` itself).
 *   `"./.mcp.json"` names the root file; any other `.json` is a separate
 *   plugin config, and the root file is then project-scoped. `.mcpb`/`.dxt`
 *   bundles and URLs are skipped: their config is not in the repo;
 * - **an inline object**: the plugin config lives in plugin.json itself, and
 *   the root file is project-scoped.
 *
 * `mcp` is NOT a key Claude Code reads ("Unknown field 'mcp'. Claude Code
 * ignores it at load time"). Two fleet repos (office-outlook-mcp,
 * microsoft-teams-mcp) declare `"mcp": "./mcp.json"` meaning
 * `.claude-plugin/mcp.json`; it is resolved here as the author intended so the
 * root file is not wrongly told to use `${CLAUDE_PLUGIN_ROOT}`, and reported
 * (`ignoredMcpKey`) so it gets renamed. The other 57 declare
 * `"mcp": "./.mcp.json"`, the default Claude Code loads anyway: harmless
 * today, but still an ignored key, and the one that, copied with another
 * path, broke those two plugin installs. It is reported too
 * (`ignoredMcpKeyIsDefault` picks the softer message) so the fleet renames it
 * to `mcpServers`.
 *
 * Caveat: Claude Code loads the plugin root's `.mcp.json` FIRST and merges the
 * declared configs over it (a later server name replaces an earlier one), so a
 * project-scoped root server whose name the plugin config does not override
 * also starts in a plugin install whose source ships the root file. That is
 * not checked here.
 *
 * @param {{ file: string, json: any } | undefined} plugin parsed plugin.json
 * @param {(rel: string) => { file: string, json: any } | null | undefined} readConfig
 *   reads a plugin-root-relative path: the parsed file, `null` when it does
 *   not exist, `undefined` when it exists but could not be parsed (the loader
 *   reports that itself).
 * @param {(rel: string) => boolean} isRootMcpJson whether a path names the root `.mcp.json`
 */
export function resolvePluginMcp(plugin, readConfig, isRootMcpJson) {
  const none = { rootIsPluginConfig: true, configs: [], missing: [], ignoredMcpKey: false, ignoredMcpKeyIsDefault: false };
  if (!plugin || typeof plugin.json !== 'object' || plugin.json === null) return none;
  const hasServers = plugin.json.mcpServers !== undefined;
  const ignoredMcpKey = !hasServers && plugin.json.mcp !== undefined;
  const value = hasServers ? plugin.json.mcpServers : plugin.json.mcp;
  if (value === undefined) return none;
  const field = hasServers ? 'mcpServers' : 'mcp';
  const out = { rootIsPluginConfig: false, configs: [], missing: [], ignoredMcpKey, ignoredMcpKeyIsDefault: false, field, pluginFile: plugin.file };
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry === 'string') {
      if (BUNDLE_OR_URL.test(entry)) continue;
      if (isRootMcpJson(entry)) { out.rootIsPluginConfig = true; continue; }
      const cfg = readConfig(entry);
      if (cfg === null) out.missing.push(entry);
      else if (cfg) out.configs.push(cfg);
    } else if (entry && typeof entry === 'object') {
      out.configs.push({ file: plugin.file, json: { mcpServers: entry } });
    }
  }
  // An ignored `"mcp": "./.mcp.json"` names the default Claude Code uses
  // anyway, so it changes nothing today; it is still reported, with a softer
  // message, because the key itself is ignored.
  out.ignoredMcpKeyIsDefault = ignoredMcpKey && out.rootIsPluginConfig && out.configs.length === 0 && out.missing.length === 0;
  return out;
}

/**
 * The `${CLAUDE_PLUGIN_ROOT}` anchor rule, applied to the config the plugin
 * actually uses. Claude Code defines CLAUDE_PLUGIN_ROOT for a plugin install
 * only; a project-scoped `.mcp.json` that uses it launches `node /dist/…` and
 * the server dies at startup (office-outlook-mcp, guarded by its
 * tests/server-boot.test.ts; tempo-api-mcp, regressed by following the
 * previous version of this lint). So:
 * - the plugin config (the root `.mcp.json` when it is one, a separate file,
 *   or inline plugin.json servers) must not run a cwd-relative path;
 * - a root `.mcp.json` that is NOT the plugin config must not use
 *   `${CLAUDE_PLUGIN_ROOT}`;
 * - a declared config that does not exist, and any `mcp` key (even one naming
 *   the default), are reported.
 * Without a plugin.json the root `.mcp.json` is treated as the plugin config,
 * as before.
 * @param {{ mcpJson?: { file: string, json: any }, pluginMcp?: ReturnType<typeof resolvePluginMcp> }} s
 * @returns {SurfaceFinding[]}
 */
export function mcpConfigPathFindings({ mcpJson, pluginMcp }) {
  const p = pluginMcp ?? { rootIsPluginConfig: true, configs: [], missing: [], ignoredMcpKey: false, ignoredMcpKeyIsDefault: false };
  const out = [];
  if (p.ignoredMcpKey && p.ignoredMcpKeyIsDefault) {
    out.push({
      check: 'env', code: 'plugin-json-mcp-ignored', subject: 'mcp', file: p.pluginFile,
      message: `${p.pluginFile} declares "mcp", a key Claude Code ignores (claude plugin validate: "Unknown field 'mcp'"). `
        + 'It is harmless today, because the path it names, ./.mcp.json, is the default a plugin install loads anyway — but copies of this key with other paths broke plugin installs. '
        + 'Rename it to "mcpServers" (e.g. "mcpServers": "./.mcp.json"), or drop it to rely on the default.',
    });
  } else if (p.ignoredMcpKey) {
    out.push({
      check: 'env', code: 'plugin-json-mcp-ignored', subject: 'mcp', file: p.pluginFile,
      message: `${p.pluginFile} declares "mcp", a key Claude Code ignores (claude plugin validate: "Unknown field 'mcp'"), so a plugin install loads the root .mcp.json instead. `
        + 'Rename it to "mcpServers", with the path relative to the plugin root, not to .claude-plugin/ — e.g. "mcpServers": "./.claude-plugin/mcp.json" — and keep the server names the same as the root .mcp.json so the plugin config replaces them.',
    });
  }
  for (const rel of p.missing) {
    out.push({
      check: 'env', code: 'plugin-mcp-config-missing', subject: rel, file: p.pluginFile,
      message: `${p.pluginFile} ${p.field} names ${rel}, which does not exist. Paths resolve against the plugin root (the directory holding .claude-plugin/), so Claude Code fails this plugin's MCP config with "path not found".`,
    });
  }
  if (mcpJson && p.rootIsPluginConfig) out.push(...mcpJsonPathFindings(mcpJson));
  for (const cfg of p.configs) out.push(...mcpJsonPathFindings(cfg));
  if (mcpJson && !p.rootIsPluginConfig) {
    for (const [name, s] of Object.entries(mcpJson.json?.mcpServers ?? {})) {
      if (!JSON.stringify(s ?? {}).includes('CLAUDE_PLUGIN_ROOT')) continue;
      out.push({
        check: 'env', code: 'mcp-json-plugin-root-in-project-config', subject: name, file: mcpJson.file,
        message: `${mcpJson.file} server "${name}" uses \${CLAUDE_PLUGIN_ROOT}, but this file is not the plugin's MCP config (${p.pluginFile} ${p.field} points elsewhere), so it is loaded project-scoped. `
          + 'Claude Code defines CLAUDE_PLUGIN_ROOT only for a plugin install, so a project-scoped launch runs e.g. `node /dist/index.js` and the server dies at startup. Use a path relative to the repo root here; keep the anchor in the plugin config.',
      });
    }
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
// Never part of the built server: vendored deps, VCS/tool dot-dirs, test
// trees and coverage reports. Matters when `bin` sits at the package root
// (`"bin": "index.js"`), where the walk would otherwise cover the whole repo.
const SKIP_DIRS = new Set(['node_modules', 'coverage', 'test', 'tests', '__tests__']);
const TEST_FILE = /\.(?:test|spec)\.(?:c|m)?js$/;
// The fleet's esbuild output (`dist/bundle.js`): the server plus every
// dependency inlined, so its env reads are not all the server's.
const BUNDLE_FILE = /^bundle\.(?:c|m)?js$/;

/**
 * Built source under `dir`, split into the tsc output (`own`) and esbuild
 * bundles (`bundle`), each concatenated. Never throws: a directory or file
 * that cannot be read (a dangling symlink, a symlink to a directory, EACCES)
 * is skipped and reported through `onError`. Symlinked directories are not
 * followed, so a link cycle cannot loop.
 * @param {string} dir
 * @param {(path: string, e: Error) => void} onError
 */
function readBuiltSource(dir, onError) {
  const own = [];
  const bundle = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (e) {
      onError(d, e);
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p);
        continue;
      }
      if (!SOURCE_EXT.test(e.name) || TEST_FILE.test(e.name)) continue;
      try {
        (BUNDLE_FILE.test(e.name) ? bundle : own).push(readFileSync(p, 'utf8'));
      } catch (err) {
        onError(p, err);
      }
    }
  };
  walk(dir);
  return { own: own.join('\n'), bundle: bundle.join('\n'), hasOwn: own.length > 0 };
}

/**
 * Everything the surface checks read: the built source (every .js/.mjs/.cjs
 * under the entry's directory; node_modules, dot-dirs, test trees, coverage
 * and *.test/*.spec files skipped) and each config file
 * present beside the entry's package.json. Env reads come from the tsc output
 * alone when any exists, else from `bundle.js` (`code.bundled`); `code.text`
 * holds both. File paths are reported relative to `cwd`, which is the repo
 * root in CI.
 * @param {string} entry
 * @param {string} [cwd]
 */
export function loadSurface(entry, cwd = process.cwd()) {
  const pkgDir = findPackageDir(entry);
  const entryDir = dirname(resolve(entry));
  const errors = [];
  const unreadable = (p, e) => {
    const file = relative(cwd, p) || p;
    errors.push({
      check: 'surface', code: 'unreadable-source', subject: file, file,
      message: `${file} could not be read (${e.code ?? e.message}), so the env checks skipped it.`,
    });
  };
  const src = statSync(entryDir).isDirectory()
    ? readBuiltSource(entryDir, unreadable)
    : { own: '', bundle: '', hasOwn: false };
  // tsc output wins whenever there is any; the bundle is the fallback.
  const bundled = !src.hasOwn && src.bundle !== '';
  const text = [src.own, src.bundle].filter(Boolean).join('\n');
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
  const rootMcpJson = join(pkgDir, '.mcp.json');
  const plugin = load(join('.claude-plugin', 'plugin.json'));
  const pluginMcp = resolvePluginMcp(
    plugin,
    (rel) => (existsSync(join(pkgDir, rel)) ? load(rel) : null),
    (rel) => resolve(pkgDir, rel) === rootMcpJson,
  );
  return {
    code: { text, reads: collectEnvReads(bundled ? src.bundle : src.own), bundled },
    manifest: load('manifest.json'),
    serverJson: load('server.json'),
    mcpJson: load('.mcp.json'),
    pluginMcp,
    errors,
  };
}

/**
 * Every surface warning for a served tool list. Never throws: the checks are
 * advisory, so a crash in them (an unreadable tree, a filesystem race) must
 * not change the lint's exit code. It becomes one `surface` warning instead,
 * which fails the run only under `--strict`.
 * @param {string} entry
 * @param {Array<{ name: string, annotations?: Record<string, unknown> }>} tools
 * @param {{ load?: typeof loadSurface }} [opts] `load` is a test seam.
 */
export function collectSurfaceWarnings(entry, tools, { load = loadSurface } = {}) {
  try {
    const surface = load(entry);
    return [
      ...annotationHintFindings(tools),
      ...(surface.manifest ? manifestToolDriftFindings(surface.manifest.json, tools.map((t) => t.name), surface.manifest.file) : []),
      ...envDriftFindings(surface),
      ...mcpConfigPathFindings(surface),
      ...surface.errors,
    ];
  } catch (e) {
    return [{
      check: 'surface', code: 'surface-check-failed', subject: entry,
      message: `The surface checks crashed (${e instanceof Error ? e.message : String(e)}), so annotations, manifest tools[] and env drift were not checked.`,
    }];
  }
}
