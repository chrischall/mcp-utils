#!/usr/bin/env node
/**
 * Print what a BUILT MCP server actually publishes, per tool.
 *
 *   node scripts/audit-annotations.mjs ../some-mcp/dist/index.js
 *   node scripts/audit-annotations.mjs ../some-mcp/dist/index.js --summary
 *
 * Why this exists rather than a grep: across a 16-repo annotation sweep every
 * bug that mattered was found here and none was found by reading source.
 * Source lies in four ways — an annotation can come from a shared registrar
 * rather than the call site, a regex window bleeds into the next declaration,
 * an inner `toolAnnotations({...})` can be overridden by an outer
 * `destructiveHint`, and `toolAnnotations` DEFAULTS `readOnly` to true so a
 * missing key is a read rather than a write.
 *
 * Read it PER TOOL. The summary counts looked plausible every single time
 * something was wrong; only the per-tool list showed it.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = process.argv[2];
if (!entry) {
  console.error('usage: audit-annotations.mjs <path/to/dist/entry.js> [--summary]');
  process.exit(2);
}
const summaryOnly = process.argv.includes('--summary');

/** The EFFECTIVE class, applying the spec defaults rather than what is written. */
const classOf = (a = {}) =>
  a?.readOnlyHint === true ? 'read'
  : a?.destructiveHint === false ? 'additive'
  : 'DESTRUCTIVE';   // destructiveHint defaults to TRUE — silence lands here

const client = new Client(
  { name: 'audit-annotations', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5000 } } },
);
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [entry], env: process.env, stderr: 'ignore',
}));

const tools = [];
let cursor;
do {
  const page = await client.listTools(cursor ? { cursor } : {});
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
await client.close();

const counts = { read: 0, additive: 0, DESTRUCTIVE: 0, unannotated: 0 };
for (const t of tools) {
  counts[classOf(t.annotations)]++;
  if (!t.annotations) counts.unannotated++;
}

if (!summaryOnly) {
  for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const cls = classOf(t.annotations);
    // Flag the case that is nearly always an oversight rather than a decision.
    const why = t.annotations ? '' : '  <- no annotations; destructive BY DEFAULT';
    console.log(`  ${cls.padEnd(11)} ${t.name}${why}`);
  }
  console.log('');
}
console.log(`${tools.length} tools   read ${counts.read}   additive ${counts.additive}   destructive ${counts.DESTRUCTIVE}   unannotated ${counts.unannotated}`);
