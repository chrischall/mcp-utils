#!/usr/bin/env node
/**
 * Audit EVERY built MCP server beside this repo, and flag the one direction
 * that costs safety: a tool named for an irreversible act that claims to be
 * read-only or additive.
 *
 *   node scripts/audit-fleet-annotations.mjs           # ../*-mcp
 *   node scripts/audit-fleet-annotations.mjs --all     # every tool, not just suspects
 *   node scripts/audit-fleet-annotations.mjs ~/git     # a different parent
 *
 * WHY A FLEET PASS AND NOT A GREP. A source scan answers "which repos use
 * `toolAnnotations`", which is NOT "which repos have correct annotations".
 * Both false claims ever found in this fleet — `outlook_send_mail` and
 * honeybook's `send_message`, each declaring `destructiveHint: false` on a
 * tool that mails a third party — were in repos with zero `toolAnnotations`
 * call sites, so no source scan would ever have reached them. Reading the
 * wire is the only thing that answers the question, and 63 servers take one
 * pass.
 *
 * It reports SUSPECTS, not verdicts. Every hit needs a human to read the
 * tool's description, because the rule is "is there an inverse in this same
 * tool set?" and no keyword knows that. `resy_remove_favorite` looks alarming
 * and is correctly additive; `send_message` looks ordinary and is not.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const parent = resolve(args.find((a) => !a.startsWith('--')) ?? join(process.cwd(), '..'));

const classOf = (a = {}) =>
  a?.readOnlyHint === true ? 'read'
  : a?.destructiveHint === false ? 'additive'
  : 'DESTRUCTIVE';

/**
 * Words meaning the world changed in a way you cannot take back.
 *
 * Matched on TOKEN BOUNDARIES, which is the whole of the noise control: a
 * bare substring match made every `freshbooks_*` and `honeybook_*` tool hit
 * on "book" and buried two real findings under 24 false ones, while
 * `(^|_)book(_|$)` does not fire on "honeybook" or "bookings" at all.
 *
 * Do NOT "improve" this by stripping a server prefix first. That was tried,
 * and it silently broke the tool: honeybook's tools are UNPREFIXED, so
 * stripping the leading token turned `send_message` into `message` and the
 * auditor stopped seeing the very finding it exists for. Caught by mutation-
 * checking it against a known-bad annotation, not by reading it.
 */
const IRREVERSIBLE =
  /(^|_)(send|delete|remove|cancel|purge|destroy|revoke|pay|checkout|purchase|book|unlock|disarm|submit|post|invite|share|publish|archive|trash|wipe|decline)(_|$)/;

async function toolsOf(entry) {
  const client = new Client({ name: 'fleet-audit', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5000 } } });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [entry], env: process.env, stderr: 'ignore',
  }));
  const out = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    out.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  await client.close();
  return out;
}

const repos = readdirSync(parent, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.endsWith('-mcp'))
  .map((d) => d.name)
  .sort();

const totals = { read: 0, additive: 0, DESTRUCTIVE: 0 };
const suspects = [];
let servers = 0;
const unreadable = [];

for (const repo of repos) {
  const entry = ['dist/index.js', 'dist/bundle.js']
    .map((p) => join(parent, repo, p))
    .find(existsSync);
  if (!entry) continue;
  let tools;
  try { tools = await toolsOf(entry); } catch { unreadable.push(repo); continue; }
  servers++;
  for (const t of tools) {
    const cls = classOf(t.annotations);
    totals[cls]++;
    if (cls !== 'DESTRUCTIVE' && IRREVERSIBLE.test(t.name)) suspects.push([repo, cls, t.name]);
    if (showAll) console.log(`  ${cls.padEnd(11)} ${repo.padEnd(24)} ${t.name}`);
  }
}

if (showAll) console.log('');
console.log(`${servers} servers   read ${totals.read}   additive ${totals.additive}   destructive ${totals.DESTRUCTIVE}`);
if (unreadable.length) console.log(`could not start: ${unreadable.join(', ')}`);

console.log(`\n${suspects.length} SUSPECT${suspects.length === 1 ? '' : 'S'} — named for an irreversible act, annotated safe.`);
console.log('Read each description; the test is whether an inverse exists in the same tool set.\n');
for (const [repo, cls, name] of suspects) console.log(`  ${cls.padEnd(9)} ${repo.padEnd(24)} ${name}`);
process.exit(suspects.length ? 1 : 0);
