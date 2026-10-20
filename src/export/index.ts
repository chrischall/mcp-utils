/**
 * `@chrischall/mcp-utils/export` — bulk-export plumbing shared by the fleet.
 *
 * Zero optional peers (`node:crypto`, `node:zlib`, `node:fs` plus the core
 * `config`, `errors` and `fs` modules). It is a subpath rather than part of
 * the core barrel because only the servers that write exports or hand out
 * hosted files need it.
 *
 *  - {@link blobStoreFromEnv} / {@link createBlobStore} — mcp-host's shared
 *    blob store: signed GET/PUT URLs (gateway payloads byte for byte) and the
 *    PUT itself. Consolidates splitwise-mcp `_blob.ts` and gemini-mcp
 *    `blob-store.ts`; consumed by office-outlook-mcp and microsoft-teams-mcp
 *    bulk export.
 *  - {@link openExportSink} — where an export's files go: a fresh local
 *    directory (absolute paths; per-call `dest` confined) on a stdio install,
 *    or one zip PUT to the blob store with a signed link on mcp-host. Plus the
 *    resume-cursor codec, `jsonlLine`, part / attachment file naming.
 *  - {@link buildZip} — the STORE/DEFLATE zip writer behind blob mode, ported
 *    from gemini-mcp `zip.ts`.
 */

export * from './blob.js';
export * from './sink.js';
export * from './zip.js';
