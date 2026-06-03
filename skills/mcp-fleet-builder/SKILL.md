---
name: mcp-fleet-builder
description: "Build or modify a chrischall MCP server (the ~19 *-mcp repos under ~/git) on @chrischall/mcp-utils — skeleton, bearer vs fetchproxy archetypes, bootstrap, and release/CI gotchas."
---

# Building a chrischall fleet MCP

The fleet is ~19 sibling MCP servers under `~/git/*-mcp`, all on the same skeleton and sharing `@chrischall/mcp-utils` (generic scaffolding), `@fetchproxy/server` (browser-bridge HTTP for sites without an API), and `@chrischall/realty-core` (realty math). Build new ones the same way; don't reinvent the glue.

Canonical examples to copy from: **splitwise-mcp** (bearer/direct-API archetype), **redfin-mcp** / **zillow-mcp** (fetchproxy archetype).

## Skeleton

```
src/
  index.ts        # bootstrap — runMcp({ name, version, banner, deps, tools })
  client.ts       # API client (reads creds, talks to the service)
  tools/<area>.ts # registerXxxTools(server, deps) → server.registerTool(...)
tests/            # vitest; no real network (mock fetch / the bridge)
  version-sync.test.ts   # versionSyncTest from @chrischall/mcp-utils/test
SKILL.md, manifest.json, server.json, .mcp.json, .claude-plugin/  # packaging
.github/workflows/   # ci, release-please / tag-and-bump, pr-auto-review, auto-merge
```

Each `tools/*.ts` exports `registerXxxTools(server, deps)` that calls `server.registerTool(name, { description, annotations, inputSchema }, handler)` (high-level `McpServer` API with zod). `index.ts` only wires them.

## @chrischall/mcp-utils surface

Core entry (zero runtime deps — safe for any MCP):
- `server`: `createMcpServer`, `runMcp({ name, version, banner?, deps, tools })`, `withGracefulShutdown`, `ToolRegistrar`
- `response`: `textResult(data)` (the universal `{content:[{type:'text',text:JSON.stringify(data,null,2)}]}`), `errorResult`, `imageResult`, `rawTextResult`, `flattenJsonApi`
- `errors`: `McpToolError` + `SessionNotAuthenticatedError`/`BotWallError`/`RateLimitError`/`UnreachableError`/`ModeMismatchError`, `createHelpfulError`, `wrapToolError`, `truncateErrorMessage` (redacts Bearer/JWT then caps at 500), `messageOf`
- `config`: `readEnvVar`/`requireEnvVar` (trim + treat `''`/`'undefined'`/`'null'`/`${...}` as unset), `parseBoolEnv`, `loadDotenvSafely`, `expandPath`
- `http`: `createApiClient({baseUrl,getToken,retry?})`, `buildQueryString`, `buildOptionalBody`, `formatApiError`, `parseLinkHeader`, `parseCookieJar`, `decodeJwtExp`/`decodeJwtSessionId`/`validateJwtExpiry`
- `zod`: `paginationSchema`/`pageSchema`, `calculateOffset`, `toolAnnotations`, atoms (`PositiveInt`/`NonNegInt`/`NonEmptyString`/`IsoDate`/`IsoTime`), `extractTime`/`normalizeTime`
- `auth`: `createAuthResolver`, `resolveAuthPattern`, `sessionLoginFlow`, `createOAuth2Refresher`

Subpath entries (only pull their heavy/optional dep when imported):
- `@chrischall/mcp-utils/session` — `createSessionRegistry`, `registerSessionTools`, `SessionStore` (disk, 0600/0700), `TokenManager` (race-safe refresh)
- `@chrischall/mcp-utils/fetchproxy` — `createFetchproxyTransport`, `createBootstrapOpts`, re-exports of `@fetchproxy/server` primitives + `classifyBridgeError`
- `@chrischall/mcp-utils/html` — `parsePropertyTable`, `extractJsonFromHtml`, etc. (needs `node-html-parser`)
- `@chrischall/mcp-utils/test` — `createTestHarness`, `parseToolResult`, `versionSyncTest`

## Bootstrap (index.ts) — both archetypes

```ts
#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { FooClient } from './client.js';
import { registerThingTools } from './tools/thing.js';

// Build the client in the CALLER so the deferred-config-error pattern holds:
// the server still boots (and answers the host's install-time tools/list probe)
// when creds are absent — the error surfaces on the first tool call instead.
const client = new FooClient();

await runMcp({
  name: 'foo-mcp',
  version: '1.0.0', // x-release-please-version
  banner: '[foo-mcp] This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [registerThingTools],
});
```

**Deferred-config-error pattern** (do this in `client.ts`): the constructor reads creds via `readEnvVar`; if missing, store a `configError` instead of throwing, and re-throw it from a `requireKey()` called at request time. Lets the server start without creds.

## Archetypes

- **bearer / direct API** (splitwise, tempo, ioffice, app-store-connect, skylight): `client.ts` does `fetch` with a bearer/token header. Use `createApiClient` if it fits; always route error bodies through `formatApiError`/`truncateErrorMessage`. No fetchproxy.
- **fetchproxy / browser-bridge** (realty cohort, reservations, finance, school): the site has no public API, so requests go through a signed-in browser tab via `@fetchproxy/server`. `src/transport-fetchproxy.ts` wraps it; session tools expose/select accounts. Use `@chrischall/mcp-utils/fetchproxy` **only on `@fetchproxy/server` >= 0.11** (it re-exports 0.11+ APIs). Repos on older pins keep their own transport until a deliberate bump.

### fetchproxy specifics (hard-won — each was a real failure in the musescore-mcp build)

- **One shared port: `37149`.** The whole fetchproxy fleet binds the SAME concentrator port — the **Transporter** browser extension dials that ONE port, and servers host/peer-elect on it (first to bind is host; the rest are peers tunneling through it). A new fetchproxy MCP MUST default to `37149` (`DEFAULT_PORT = 37_149`; env override `<SVC>_WS_PORT`). Give it a "unique" port and the extension never connects (`ws://127.0.0.1:NNNNN … ERR_CONNECTION_REFUSED`) — it has no idea your port exists. Copy the port from a sibling (zillow/redfin); don't pick a new one.
- **Lazy bind + one-time pairing.** `listen()` reserves nothing; the port binds + role-elects on the FIRST verb call (or `connect()`). A brand-new server's identity (`~/.fetchproxy/identity/<server>.json`, auto-created) is unknown to the extension, so the first request returns `pairing required … pair code: NNN-NNN` — the user approves it ONCE in the Transporter popup (TOFU, per-identity, persists). Onboarding a new fetchproxy MCP = (1) default port 37149, (2) trigger one call (`<svc>_healthcheck`), (3) approve the pair code in Transporter.
- **Parse the SSR JSON store; verify against RAW-FETCHED bytes, not the hydrated DOM.** Modern SPAs render NO cards/tables in the fetched HTML (client-hydrated) — the data is an entity-encoded JSON store (a `__NEXT_DATA__` analogue, often attribute-escaped: `&quot;`/`&amp;`). The MCP parses what fetchproxy fetches = raw SSR, which ≠ `document.querySelectorAll` in a live tab. Verify your parser against the actual bytes: in a signed-in tab run `await fetch(path,{credentials:'include'}).then(r=>r.text())` and parse THAT. Recover-from-entities + bracket-match (don't regex nested JSON); skip any bot-manager fields (`bm_*`, `client_ip`, `ja3`/`ja4`) that ride along in the store.
- **Tighten Cloudflare detection.** The shared `classifyBotWall` covers perimeterx/datadome; for Cloudflare-walled sites detect the interstitial by DEFINITIVE markers only — `_cf_chl_opt` and `<title>Just a moment`. Do NOT match `cdn-cgi/challenge-platform` / `challenges.cloudflare.com` (Cloudflare inlines those on CLEARED pages too) or gate on body size — that false-positives on legit pages under ~80 KB (it made every score-page fetch wrongly report a bot-wall while the bigger search pages sailed through, so "search works but detail pages fail" is the tell).
- **The bridge does `fetch()` — it can't navigate, follow cross-origin redirects, or stream binaries.** Endpoints that only work as a browser NAVIGATION — file downloads with `Content-Disposition: attachment`, or a same-origin endpoint that 302s cross-origin to a presigned S3 URL — can't be fetched: the bridge's `fetch` throws on the cross-origin redirect, and a server-side node `fetch` hits the Cloudflare wall (403). Such a tool can only **resolve** the URL (return it for the user to open), not download the file. Don't scrape the page's render tiles to fake it.
- **Verify a real SUCCESS, at the right layer, before coding the gate.** Downloads/navigations DON'T appear in XHR/`fetch`/HAR monitoring — watching those and concluding "nothing happens" is wrong. Confirm an actual artifact end-to-end (a file lands on disk) and read the JSON store for the real gate field before encoding it. (Cost of skipping this: a download gate built on the wrong field — `hasAccess`, an entitlement flag — instead of `is_free`, which refused every actually-downloadable score.)

## Conventions (how chris likes them)

- **TDD, always.** Failing test → minimal code → green. Especially for write tools.
- **Verify endpoints before building them — at the right layer.** For no-API sites, capture the real request (DevTools → Network → "Copy as cURL", or a HAR) and pin the request *shape* in `docs/<SERVICE>-API.md`. Never code a write against an assumed body, and never encode a gate field you haven't seen succeed: confirm an actual successful artifact end-to-end (a real file/row), because downloads and navigations don't show up in XHR/`fetch`/HAR. Extract only the shape — **never commit captured cookies/tokens/signatures** (secret-scan before committing).
- **Confirm-gated writes.** Every mutating tool takes `confirm` (`schemaConfirm` from `zod`). Without `confirm: true` it makes **no** network call and returns a dry-run `preview()` of exactly what would be sent. Route every mutation through one private `client.write()` that attaches auth (cookie/CSRF or bearer) centrally.
- **Stream file uploads.** Never `readFileSync` a file just to wrap it in `new Blob([buf])` — use `fileBlob` / `readFileHead` from `@chrischall/mcp-utils` (or `fs.openAsBlob` directly) so a 20 MB upload isn't a 20 MB heap buffer.
- **Results:** `textResult(data)` for everything; errors via the typed `McpToolError` subclasses with an actionable `hint`.
- **Secrets:** `.env` gitignored; throwaway-test writes go only to blackholed addresses (`@example.com`); only the user's own account/data.
- **Never merge PRs or add `ready-to-merge` yourself.** Squash-merge is the default; `pr-auto-review` + `auto-merge` ship it. On a `warn`/`fail` verdict, surface the findings and ask — don't override.

## Repo bootstrap — git, labels, release-please

A new fleet repo isn't done until ALL of this exists. Each line below was a real failure when missing (CI red, review step erroring, `main` unprotected, bundle bloat).

**Workflows** (`.github/workflows/`, copy from a sibling): `ci.yml` (build+test), `pr-auto-review.yml` (Claude structured verdict → arms `ready-to-merge` on `pass` via `RELEASE_PAT`), `claude.yml` (`@claude` dispatch), `auto-merge.yml` (squash on `ready-to-merge`/dependabot), `release-please.yml` (publish: npm `--provenance` + `.mcpb` + MCP registry + ClawHub), `dependabot.yml`. **Node:** CI/publish `node-version: 26` (Current).

**Labels** — per-repo (`chrischall` is a *User* account: no org-wide labels/secrets). Create `auto-review`, `ready-to-merge`, `review-with-opus`, `autorelease: pending`, `autorelease: tagged`, plus dependabot categories (`ci`, `security`, `test`, `javascript`, `github_actions`, `ignore-for-release`). Missing `auto-review`/`ready-to-merge` → pr-auto-review's first step (`gh pr edit --add-label auto-review`) errors and arming can't happen.

**Branch protection** — two rulesets on `~DEFAULT_BRANCH` (personal account uses rulesets, not classic protection): (1) block `deletion` + `non_fast_forward`; (2) require a PR + the `ci` required status check.

**Secrets** — per-repo, set by the **human** (an agent must never set credential values): `CLAUDE_CODE_OAUTH_TOKEN` (review), `RELEASE_PAT` (release-please + the auto-merge/arm step — a `GITHUB_TOKEN`-added label won't fire downstream workflows), optional `CLAWHUB_TOKEN`; plus npm **trusted publishing** for the `--provenance` publish.

**release-please** — `release-please-config.json` (`package-name`, `release-type: node`, `changelog-sections`, `extra-files`) + `.release-please-manifest.json`. **`extra-files` MUST list every file that carries the version**, or `versionSyncTest` fails the release PR's CI: `manifest.json` `$.version`; `server.json` `$.version` + `$.packages[*].version`; `.claude-plugin/plugin.json` `$.version`; `.claude-plugin/marketplace.json` `$.plugins[*].version` + `$.metadata.version`; and **every `src/*.ts` with an `// x-release-please-version` marker** — usually `src/index.ts` AND a `SERVER_VERSION` in `src/auth.ts` (it's easy to forget the second one). Don't hand-bump; release-please does it.

**Publish scaffold** (also list in package.json `files`): `manifest.json` (mcpb; `runtimes.node` floor stays at an **LTS** like `>=22.5`, not 26, so LTS users install), `server.json` (registry; description **≤ 100 chars** or `mcp-publisher` 422s), `.claude-plugin/plugin.json` + `marketplace.json`, `.mcp.json`, `skills/<name>/SKILL.md`, and **`.mcpbignore`** so `mcpb pack` ships only `dist/bundle.js` + `manifest.json` + `package.json` — exclude `src/`, `tests/`, `docs/`, `node_modules/`, `.env*`, the registry/plugin manifests, **and** `release-please-config.json` / `.release-please-manifest.json` / `CHANGELOG.md`.

**mcp-publisher** — install via the shared pinned, SHA-256-verified action `chrischall/mcp-utils/.github/actions/install-mcp-publisher@<tag>`, NOT the upstream `releases/latest | tar xz` (that binary runs with the OIDC + RELEASE_PAT + CLAWHUB tokens).

## Gotchas (hard-won)

- **ESM + NodeNext**: every relative import ends in `.js`, even from `.ts`.
- **`"types": ["node"]`**: NodeNext repos need this in `tsconfig.compilerOptions` once they import a scoped pkg like `@chrischall/mcp-utils`, or `tsc` fails with `Cannot find name 'path'/'url'`. Add `types`, not `typeRoots`.
- **zod 4**: mcp-utils peer-requires `zod@^4.4.0`. Repos still on zod 3 must bump (schemas are compatible; `z.string().email()` is deprecated-but-works).
- **Never commit secrets**: `.env` must be gitignored. Real creds live in `.env` (local) or the MCP host's `mcp_config.env`. If `.env` is tracked, `git rm --cached` it.
- **Version sync**: version is duplicated across `package.json`, `src/index.ts` (`x-release-please-version` marker), `manifest.json`, `server.json`, `.claude-plugin/*`. Keep them equal — `versionSyncTest` from `/test` guards it. Don't hand-bump; release-please / the Tag-&-Bump action does it.
- **`server.json` description ≤ 100 chars** (MCP registry schema) — over that, `mcp-publisher publish` 422s.
- **stdio transport**: logs go to **stderr only** — stdout is reserved for JSON-RPC.
- **Don't merge PRs**: open with one release-notes label; `pr-auto-review` + `auto-merge` ship it. Never add `ready-to-merge` yourself to override a warn/fail.

## New MCP — fast path

1. Copy a same-archetype sibling's skeleton (splitwise for bearer, redfin for fetchproxy) — including its `.github/`, packaging, tsconfig, vitest. Then do the full **Repo bootstrap** (workflows, labels, rulesets, secrets, release-please extra-files, publish scaffold, `.mcpbignore`) — it's the part that's easy to half-do.
2. Add `"@chrischall/mcp-utils"` (published `^x` once available; `file:../mcp-utils/<tarball>` pre-publish).
3. Write `client.ts` (deferred-config-error + one central `write()`), `tools/*.ts` (`registerTool` + `textResult`, **`confirm`-gated** writes with a dry-run `preview()`), wire `index.ts` with `runMcp`. TDD; verify endpoints from a capture before coding writes.
4. Tests with `createTestHarness` + `versionSyncTest`; mock the network. Keep them green.
5. `npm run build && npm test`. Branch + PR; let auto-merge ship it (never merge it yourself).
