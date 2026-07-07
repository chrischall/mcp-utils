# @chrischall/mcp-utils

Shared scaffolding for the **chrischall MCP fleet** — the generic MCP glue hoisted out of ~19 sibling `*-mcp` servers (under `~/git/*-mcp`) so none of them reimplements server bootstrap, tool-result formatting, errors, env/config hardening, a bearer API-client kit, zod atoms, session management, the fetchproxy transport adapter, auth resolver skeletons, the test harness, or HTML helpers. This is a **library**, not an MCP server — it has no `bin`, registers no tools of its own, and is consumed via npm by the fleet.

## Commands

```bash
npm install            # install deps
npm run build          # tsc -b (composite build → dist/)
npm run typecheck      # tsc -b --noEmit false
npm test               # vitest run (the gate)
npm run test:watch     # vitest in watch mode

# single file / pattern
npx vitest run src/http/index.test.ts
npx vitest run -t "buildQueryString"
```

Tests are colocated as `src/**/*.test.ts` (run by vitest) and excluded from the build by `tsconfig.json`. There is **no lint step** and **no enforced coverage threshold** (`@vitest/coverage-v8` is installed but no thresholds are configured) — `npm test` is the bar. CI runs on Node **26**.

## Architecture

The package exports a light **core barrel** plus heavier **subpath entries** so a bearer-only MCP can import the core without pulling optional peer deps. Each module lives in `src/<module>/index.ts` with a colocated `index.test.ts`.

| Import | Module(s) | Notes |
| --- | --- | --- |
| `@chrischall/mcp-utils` | `server` `response` `errors` `config` `fs` `http` `concurrency` `dates` `zod` `auth` `scrape` | core barrel — re-exported from `src/index.ts` |
| `@chrischall/mcp-utils/session` | `session` | session registry / disk store / `TokenManager` / `CookieSessionManager` |
| `@chrischall/mcp-utils/fetchproxy` | `fetchproxy` | transport adapter; needs optional peer `@fetchproxy/server` |
| `@chrischall/mcp-utils/html` | `html` | HTML scraping helpers; needs optional peer `node-html-parser` |
| `@chrischall/mcp-utils/scrape` | `scrape` | convenience alias; `scrape` is zero-dep and also in the core barrel |
| `@chrischall/mcp-utils/test` | `test` | in-memory vitest harness; devtime-only, never imported by runtime code |

`scrape` is the one module reachable **both** ways: it's zero-dep so it stays in the core barrel (root import), and it *also* has a `/scrape` subpath for parity with `/html` — a convenience, not a load-bearing split. (The `/session`, `/fetchproxy`, `/html`, `/test` subpaths ARE load-bearing — they isolate optional peer deps.)

The subpath split is **load-bearing, not cosmetic**: `@fetchproxy/server`, `node-html-parser`, and `vitest` are *optional* peer deps. The core barrel (`src/index.ts`) must never transitively import any of them, or every consumer would have to install fetchproxy. Keep fetchproxy-typed errors and the bridge classifier in `src/fetchproxy/` (the core `errors` module duck-types `FetchproxyBridgeDownError` rather than importing it). When adding a module, decide core-vs-subpath by its dependency footprint and add the export to both `package.json#exports` and the README table.

What each core module owns (see the long header docblock at the top of each `index.ts` for the authoritative contract):
- **server** — `createMcpServer` / `runMcp` / `withGracefulShutdown`. Transport- and domain-agnostic; the caller builds its client in `deps` so the deferred-config-error pattern (server boots before creds exist) is preserved.
- **response** — `textResult`/`jsonResult`/`rawTextResult`/`imageResult`/`errorResult`, plus `flattenJsonApi` / `deepMapStringField`.
- **errors** — `McpToolError` hierarchy + `redactSecrets` / `truncateErrorMessage` / `wrapToolError`. **Zero runtime deps by design.**
- **config** — `readEnvVar` / `requireEnvVar` / `parseBoolEnv` / `readPortEnv` / `expandPath` and friends. Hardened: trims, and treats `''`, `'null'`, `'undefined'`, and unsubstituted `${...}` placeholders as **unset**.
- **http** — `createApiClient` (bearer fetch with 429 retry, 401→`UnauthorizedError`, 204 handling, redacted errors), `buildQueryString`, `parseLinkHeader`, cookie-jar + JWT helpers, `runBoundedBatch`.
- **concurrency** — `mapLimit` (zero-dep ordered bounded fan-out).
- **dates** — pure lexical date reformatters (no `Date`/`Intl` — avoids timezone off-by-one).
- **zod** — schema atoms + tool-annotation helpers (zod v4, raw-shape style).
- **auth** — credential-resolver *skeletons*; per-site params are injected, nothing branches on site identity. Plus `createCachedTokenSource` (single-flight cached mint) and `signEs256Jwt`.
- **scrape** — zero-dep string/JSON extraction for SSR pages (entity decode, balanced-bracket walking, JSON-LD/OpenGraph readers, deep shape-walkers, Cloudflare-interstitial detection, anti-XSSI guard strip). DOM-level scraping stays in `/html` (optional peer).
- **session** — `SessionRegistry` (in-memory), `SessionStore` (disk, 0600/0700 perms), `TokenManager` (single-flight refresh + 401-replay), `CookieSessionManager`.

## Security posture (do not regress)

This package handles bearer tokens, cookies, and JWTs on behalf of the whole fleet, so it's the one audited place this logic lives.

- **Error messages must never echo a credential.** `formatApiError` and `errorResult` run every upstream body through `redactSecrets` (Bearer/Basic headers, Cookie/Set-Cookie values, JWTs, `sk-`/`ghp_`/`xox?-`/`AIza`/`AKIA`/`whsec_` key shapes, secret URL query params) *before* truncating. A 401 yields a fixed string, never the token. When touching anything that formats an upstream response into a thrown/returned message, keep redaction first.
- `SessionStore` writes with **0600 file / 0700 dir** perms.
- Env reads go through the hardened `readEnvVar` placeholder/`null`/`undefined` suppression — the canonical defense against hosts forwarding an unexpanded `.mcp.json` env block.

## Conventions

- **ESM, `moduleResolution: Bundler`.** `verbatimModuleSyntax` is on, so use `import type` for type-only imports. Relative imports use `.js` extensions (e.g. `import { redactSecrets } from '../errors/index.js'`).
- **`strict` + `noUncheckedIndexedAccess`** are on — indexed access is `T | undefined`; narrow it.
- **Every exported symbol gets a docblock**, and each module starts with a header comment explaining *what it consolidates and why* (which fleet repos it dedups). Match that density when adding to a module — these headers are the spec.
- **Public-API changes need tests.** Add cases to the colocated `*.test.ts`; the `test` subpath's `versionSyncTest` is the release-please drift guard fleet repos use, so don't break its shape.

## Releases (release-please, do not hand-bump)

`release-please` owns versioning. Don't edit `version` in `package.json`, `.release-please-manifest.json`, or create tags by hand.

- It reads **Conventional Commit** messages on `main`. Because the repo squash-merges, **the PR title becomes the squash subject** that release-please parses — so the PR title must be a conventional commit (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `chore:`, …). A non-conventional title bumps nothing and ships nothing.
- Changelog sections are configured in `release-please-config.json` (`feat`→Features, `fix`→Bug Fixes, `perf`→Performance, `revert`→Reverts, `refactor`→Refactor, `docs`→Documentation; `test`/`build`/`ci`/`chore` are hidden).
- Merging the release PR tags `v<VERSION>` and the `publish` job ships to npm with provenance (OIDC). Publish is idempotent (skips a version already on the registry).

## How PRs merge (automated — don't run `gh pr merge`)

Default workflow is **branch + PR**, even for solo work. The `chrischall/workflows` pipeline (thin stubs in `.github/workflows/{pr-auto-review,auto-merge}.yml`) handles merging:

1. `pr-auto-review.yml` runs a Claude review on each PR. A `pass` **or** `warn` verdict arms `ready-to-merge`; only a `fail` blocks. (`warn` = nits only — it still auto-merges; see the follow-up convention below.)
2. `auto-merge.yml` arms `gh pr merge --auto --squash` on the `ready-to-merge` label (and on dependabot PRs). CI (`ci.yml`) is gated to run only once `ready-to-merge` is present (or `release-ready` on a release PR), so review findings get fixed before CI burns a run; bot PRs run CI unconditionally.

For an ordinary PR, opening with `gh pr create` (and an appropriate label) is the whole job — don't open it until the change is genuinely done, since it can auto-merge as soon as review passes. If a verdict is `warn`/`fail` and you've decided to ship anyway, surface the findings and confirm before adding `ready-to-merge` yourself.

### Auto-review follow-up issues

When a PR's auto-review verdict is `warn` or `fail`, the `chrischall/workflows` pipeline opens or updates a single `auto-review-followup` issue ("Auto-review follow-ups for PR #N") whose checklist captures every finding, and links it from the PR's `<!-- auto-review-verdict -->` comment (`📋 Tracking follow-ups: #N`). `warn` (nits only) still auto-merges — the issue carries the nits forward, so most nits are fixed in a *later* PR; `fail` blocks until the important findings are addressed on the PR itself.

When asked to address the auto-review comments / review findings on a PR:

1. Read the verdict comment, open the linked `auto-review-followup` issue, and treat its checklist as the work list (alongside any inline review comments).
2. Resolve each item, checking off only what you've **verified** is genuinely fixed.
3. If every item is resolved on the current PR, add `Closes #<issue>` to that PR's body so the merge closes it; if some are deferred, check off only the resolved ones and leave the issue open.
4. For nits whose `warn` PR already auto-merged, address them in a follow-up PR that references `Closes #<issue>`.

(Mirrors the fleet-wide convention in `~/.claude/CLAUDE.md`.)

## Related

`skills/mcp-fleet-builder/SKILL.md` documents how to build/modify a fleet MCP *on top of* this library (archetypes: bearer, cookie-session, fetchproxy, rate-limited-public-API+OAuth). Read it when changing an export that the fleet's bootstrap or client patterns depend on.
