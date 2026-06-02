/**
 * `@chrischall/mcp-utils` — core barrel.
 *
 * Re-exports the framework-agnostic building blocks every server in the fleet
 * reaches for: server bootstrap, tool-result formatting, helpful errors,
 * hardened env/config, a bearer API-client kit, zod atoms, and the auth
 * resolver skeletons.
 *
 * Heavier / optional-dependency modules are published as subpath entries and
 * are intentionally NOT re-exported here:
 *   - `@chrischall/mcp-utils/session`     session registries + token manager
 *   - `@chrischall/mcp-utils/fetchproxy`  fetchproxy transport adapter
 *   - `@chrischall/mcp-utils/html`        opt-in HTML scraping helpers
 *   - `@chrischall/mcp-utils/test`        in-memory test harness
 */

export * from './server/index.js';
export * from './response/index.js';
export * from './errors/index.js';
export * from './config/index.js';
export * from './fs/index.js';
export * from './http/index.js';
export * from './zod/index.js';
export * from './auth/index.js';
