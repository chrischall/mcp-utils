#!/usr/bin/env node
/**
 * Generate AGENTS.md from CLAUDE.md, or check that it is still in sync.
 *
 *   node scripts/sync-agents-md.mjs ../some-mcp          # write, creating if absent
 *   node scripts/sync-agents-md.mjs ../some-mcp --check  # non-zero if stale or absent
 *   node scripts/sync-agents-md.mjs ~/git --all          # resync every sibling; never creates
 *
 * WHY GENERATE RATHER THAN MAINTAIN. The two files are the same document for
 * two audiences, and keeping two copies by hand is how thirteen repos ended
 * up telling readers to look in `.Codex-plugin/` — a directory that has never
 * existed. A Claude -> Codex find/replace had rewritten PATHS along with
 * prose, and also produced a nonexistent log directory, a `Codex.ai` domain,
 * a `Codex.yml` workflow and an `@Codex review this` trigger.
 *
 * Patching those one at a time is what missed most of them. CLAUDE.md is the
 * source of truth; AGENTS.md is it with the substitutions below and nothing
 * else.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Every legitimate difference between the two files, and there are only
 * three. Anything else showing up in a diff is drift, not intent.
 */
const SUBSTITUTIONS = [
  // 1. The file names itself in its own heading.
  [/^# CLAUDE\.md/m, '# AGENTS.md'],
  // 2. The fleet-policy pointer. `~/.Codex/` with a capital C resolves today
  //    only because macOS is case-insensitive; the real path is lowercase.
  [/~\/\.claude\/CLAUDE\.md/g, '~/.codex/AGENTS.md'],
  // 3. The file's own SELF-DESCRIPTION — not prose about the project, which
  //    is identical for both audiences and must not be touched. Only the
  //    sentence saying who this file is for. Missing this was flagged on
  //    gemini-mcp#243: "Guidance for Claude working in this repo" sitting in
  //    the Codex-facing file, contradicting its own pointer a few hundred
  //    lines later. "coding agents" rather than "Codex" because AGENTS.md is
  //    a tool-agnostic convention, not a Codex-specific one.
  [/^Guidance for Claude working in this repo\./m, 'Guidance for coding agents working in this repo.'],
  [/^This file provides guidance to Claude Code \(claude\.ai\/code\) when/m,
   'This file provides guidance to coding agents when'],
];

export function agentsFromClaude(claude) {
  return SUBSTITUTIONS.reduce((s, [from, to]) => s.replace(from, to), claude);
}

/**
 * Is this repo's AGENTS.md a COPY of CLAUDE.md, or its own document?
 *
 * Not every repo wants them merged, and a generator that assumes so is
 * destructive: musescore-mcp's AGENTS.md is a separate "Repository
 * Guidelines" doc and skylight-mcp's is a short "Development notes" that
 * POINTS AT CLAUDE.md. An early version of this script overwrote both.
 *
 * The test is cheap and conservative — share most of your first heading and
 * most of your lines, or you are left alone.
 */
function isCopyOf(agents, claude) {
  const lines = (t) => new Set(t.split('\n').map((l) => l.trim()).filter((l) => l.length > 12));
  const a = lines(agents);
  const c = lines(claude);
  if (a.size === 0 || c.size === 0) return false;
  let shared = 0;
  for (const l of a) if (c.has(l)) shared++;
  return shared / a.size > 0.6;
}

function run(repo, check, allowCreate) {
  const c = join(repo, 'CLAUDE.md');
  const a = join(repo, 'AGENTS.md');
  if (!existsSync(c)) return null;
  const claude = readFileSync(c, 'utf8');

  // No AGENTS.md yet. CREATING one is only right when a human named this
  // repo: whether a repo should carry the file at all is a decision, and
  // under `--all` that decision would be made for ~90 repos at once by a
  // script. So a named target creates, a sweep reports and moves on.
  if (!existsSync(a)) {
    // Silent under `--all`: whether a repo should carry the file at all is
    // not the sweep's question, and 33 "skipped" lines bury the two real
    // results it exists to surface.
    if (!allowCreate) return null;
    if (check) return 'MISSING';
    writeFileSync(a, agentsFromClaude(claude));
    return 'created';
  }

  const have = readFileSync(a, 'utf8');
  if (!isCopyOf(have, claude)) return 'own document — skipped';
  const want = agentsFromClaude(claude);
  if (want === have) return 'in sync';
  if (check) return 'STALE';
  writeFileSync(a, want);
  return 'rewritten';
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const all = args.includes('--all');
const target = resolve(args.find((x) => !x.startsWith('--')) ?? '.');

const repos = all
  ? readdirSync(target, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith('-mcp'))
      .map((d) => join(target, d.name)).sort()
  : [target];

let stale = 0;
let missing = 0;
for (const r of repos) {
  const res = run(r, check, !all);
  if (!res) continue;
  if (res === 'STALE') stale++;
  if (res === 'MISSING') missing++;
  if (res !== 'in sync' || !all) console.log(`  ${res.padEnd(11)} ${r.replace(process.env.HOME ?? '', '~')}`);
}
if (check && (stale || missing)) {
  const parts = [];
  if (stale) parts.push(`${stale} out of sync`);
  if (missing) parts.push(`${missing} absent`);
  console.error(`\nAGENTS.md: ${parts.join(', ')}. Run without --check to write.`);
  process.exit(1);
}
