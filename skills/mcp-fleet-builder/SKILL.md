---
name: mcp-fleet-builder
description: "Build or modify a chrischall MCP server (the ~19 *-mcp repos under ~/git) on @chrischall/mcp-utils — skeleton, bearer / cookie-session / fetchproxy archetypes, bootstrap, and release/CI gotchas."
---

# Building a chrischall fleet MCP

The fleet is ~19 sibling MCP servers under `~/git/*-mcp`, all on the same skeleton and sharing `@chrischall/mcp-utils` (generic scaffolding), `@fetchproxy/server` (browser-bridge HTTP for sites without an API), and `@chrischall/realty-core` (realty math). Build new ones the same way; don't reinvent the glue.

Canonical examples to copy from: **splitwise-mcp** (bearer/direct-API archetype), **artsonia-mcp** (cookie-session / username+password archetype), **redfin-mcp** / **zillow-mcp** (fetchproxy archetype).

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

**Auth preference order — avoid requiring the browser bridge at runtime.** fetchproxy needs the Transporter extension + a signed-in tab, so it's the heaviest thing to ask of a user. Pick the FIRST that authenticates cleanly, and even then keep the bridge off the hot path:

1. **username/password in `.env`** — a real server-side login (the cookie-session archetype below; or a bearer/token if the API offers one). No browser, no extension. Always try this first.
2. **fetchproxy *bootstrap*** — use the bridge ONCE to capture auth from the signed-in tab (its session cookie / storage, via `createBootstrapOpts({ bootstrap: { cookieKeys: [...] } })` → the `read_cookies`/`read_local_storage` capabilities), then make every actual request with plain node `fetch` carrying that cookie. The bridge touches only the handshake, not the workload.
3. **full-on fetchproxy** — every request routed through the signed-in tab. Only when the site can't be reached server-side at all (a hard bot-wall on every endpoint).
4. **other** — if none of the above authenticate cleanly, propose changes (to `@fetchproxy/server` / the bridge, or a different capture) to get a working *minimal-bridge* auth; don't silently settle for full-on fetchproxy.

**Whichever you land on, use node `fetch`/GET for everything the bridge isn't strictly needed for** — route only the unavoidable calls (auth, or specific walled endpoints) through fetchproxy and node-fetch the rest. Don't reach for fetchproxy just because a sibling did; reach for it only when server-side auth/fetch genuinely fails.

- **bearer / direct API** (splitwise, tempo, ioffice, app-store-connect, skylight, gemini-mcp): `client.ts` does `fetch` with a bearer/token header. Use `createApiClient` if it fits; always route error bodies through `formatApiError`/`truncateErrorMessage`. No fetchproxy. **Non-`Authorization: Bearer` auth → write a thin custom `fetch` client instead of `createApiClient`** — its `getToken` only emits `Authorization: Bearer …`. APIs with a custom auth header (`x-goog-api-key`), a model/id baked into the path (`/models/{m}:generateContent`), or binary-in-JSON responses are cleaner as a small `call()` that still uses `McpToolError` + `truncateErrorMessage` (gemini-mcp). **Binary-OUTPUT tools** (image/file generation): write bytes to a configurable dir (`<SVC>_OUTPUT_DIR` → cwd) and return the path, with an `inline` flag for base64 via `imageResult`, and non-overwriting filenames — don't dump megabytes of base64 into the result by default. These create local files / cost money but don't mutate remote state, so they are **not** `confirm`-gated (confirm is for remote writes).
- **cookie-session / username+password** (artsonia; many school/portal sites): a classic server-rendered `.asp`/`.php` site — no public API, no JSON store, no bot-wall — that accepts a real **username/password form POST** and hands back an **HttpOnly session cookie**. No browser bridge needed. `src/auth.ts` posts the login form and captures all `Set-Cookie`s into a cookie jar (use `parseCookieJar`); `src/client.ts` fetches with the jar over plain node `fetch` (`redirect: 'manual'` on the login POST so the 302's `Set-Cookie` is readable). Detect session expiry by a redirect back to the login page → **single-flight re-login** (one shared in-flight promise, à la `TokenManager`). Deferred-config reads `<SVC>_USERNAME`/`<SVC>_PASSWORD`. Parse the server-rendered HTML with `node-html-parser`. Keep `@fetchproxy/server` only as an OPTIONAL, env-selected fallback — not the default. See the **cookie-session / classic-form specifics** below.
- **fetchproxy / browser-bridge** (realty cohort, reservations, finance, school): the site has no public API AND can't be authed/fetched server-side (try options 1–2 above first), so requests go through a signed-in browser tab via `@fetchproxy/server`. `src/transport-fetchproxy.ts` wraps it; session tools expose/select accounts. Use `@chrischall/mcp-utils/fetchproxy` **only on `@fetchproxy/server` >= 0.11** (it re-exports 0.11+ APIs). Repos on older pins keep their own transport until a deliberate bump. Even here, node-fetch any endpoint that doesn't actually need the bridge.

### fetchproxy specifics (hard-won — each was a real failure in the musescore-mcp build)

- **One shared port: `37149`.** The whole fetchproxy fleet binds the SAME concentrator port — the **Transporter** browser extension dials that ONE port, and servers host/peer-elect on it (first to bind is host; the rest are peers tunneling through it). A new fetchproxy MCP MUST default to `37149` (`DEFAULT_PORT = 37_149`; env override `<SVC>_WS_PORT`). Give it a "unique" port and the extension never connects (`ws://127.0.0.1:NNNNN … ERR_CONNECTION_REFUSED`) — it has no idea your port exists. Copy the port from a sibling (zillow/redfin); don't pick a new one.
- **Lazy bind + one-time pairing.** `listen()` reserves nothing; the port binds + role-elects on the FIRST verb call (or `connect()`). A brand-new server's identity (`~/.fetchproxy/identity/<server>.json`, auto-created) is unknown to the extension, so the first request returns `pairing required … pair code: NNN-NNN` — the user approves it ONCE in the Transporter popup (TOFU, per-identity, persists). Onboarding a new fetchproxy MCP = (1) default port 37149, (2) trigger one call (`<svc>_healthcheck`), (3) approve the pair code in Transporter.
- **Parse the SSR JSON store; verify against RAW-FETCHED bytes, not the hydrated DOM.** Modern SPAs render NO cards/tables in the fetched HTML (client-hydrated) — the data is an entity-encoded JSON store (a `__NEXT_DATA__` analogue, often attribute-escaped: `&quot;`/`&amp;`). The MCP parses what fetchproxy fetches = raw SSR, which ≠ `document.querySelectorAll` in a live tab. Verify your parser against the actual bytes: in a signed-in tab run `await fetch(path,{credentials:'include'}).then(r=>r.text())` and parse THAT. Recover-from-entities + bracket-match (don't regex nested JSON); skip any bot-manager fields (`bm_*`, `client_ip`, `ja3`/`ja4`) that ride along in the store.
- **Tighten Cloudflare detection.** The shared `classifyBotWall` covers perimeterx/datadome; for Cloudflare-walled sites detect the interstitial by DEFINITIVE markers only — `_cf_chl_opt` and `<title>Just a moment`. Do NOT match `cdn-cgi/challenge-platform` / `challenges.cloudflare.com` (Cloudflare inlines those on CLEARED pages too) or gate on body size — that false-positives on legit pages under ~80 KB (it made every score-page fetch wrongly report a bot-wall while the bigger search pages sailed through, so "search works but detail pages fail" is the tell).
- **The bridge does `fetch()` — it can't navigate, follow cross-origin redirects, or stream binaries.** Endpoints that only work as a browser NAVIGATION — file downloads with `Content-Disposition: attachment`, or a same-origin endpoint that 302s cross-origin to a presigned S3 URL — can't be fetched: the bridge's `fetch` throws on the cross-origin redirect, and a server-side node `fetch` hits the Cloudflare wall (403). Such a tool can only **resolve** the URL (return it for the user to open), not download the file. Don't scrape the page's render tiles to fake it.
- **Verify a real SUCCESS, at the right layer, before coding the gate.** Downloads/navigations DON'T appear in XHR/`fetch`/HAR monitoring — watching those and concluding "nothing happens" is wrong. Confirm an actual artifact end-to-end (a file lands on disk) and read the JSON store for the real gate field before encoding it. (Cost of skipping this: a download gate built on the wrong field — `hasAccess`, an entitlement flag — instead of `is_free`, which refused every actually-downloadable score.)

### cookie-session / classic-form specifics (hard-won — the artsonia-mcp build)

- **Capture a JS-driven login by instrumenting it, not from static HTML.** Modern login forms inject the `Username`/`Password` `<input>`s via JS, so the raw HTML has only hidden fields. You can't type a password yourself (safety rule) — capture the real request by hooking `submit`/`fetch`/XHR while the USER logs in once, then replicate the form POST. (Artsonia: `POST /members/login.asp`, body `Username&Password&TargetUrl&Action=login`, `redirect:'manual'` to read the 302's HttpOnly cookie; no CSRF on these old stacks.)
- **A 302 / redirect-away is NOT proof a write persisted.** Old form handlers 302 to a content page on BOTH a real save and a silently-ignored one. Verify every write by RE-READING the resource — never trust the status code. (Cost of skipping: `set_notifications` reported success on a 302 that saved nothing.)
- **Submit a checkbox's real `value`, not `"on"`.** Classic checkboxes carry `value="Y"`; sending `name=on` is silently dropped. Capture each control's real value — checked → `name=<value>`, unchecked → omit it (as the browser does).
- **One field in a master form = read-modify-write.** If a toggle lives in a big profile form, re-POST the WHOLE form: re-send every current field verbatim (hidden ones at their real values, e.g. `DidChangePassword=N` not `0`), BLANK the password fields, flip only your target. Never send a password.
- **Verify INNER selectors against the live DOM, not just the container.** The data's in the server-rendered HTML (parse with `node-html-parser`) — top-level selectors (`.artist-card`) confirm trivially, but the child selectors you guess for a fixture (`.name`, `.date`) are usually wrong. Run the real parser logic against `await fetch(path,{credentials:'include'}).then(r=>r.text())` and diff the output before trusting it.
- **Recon through claude-in-chrome redacts secrets.** It blocks content that looks like cookies/query-strings/tokens (`[BLOCKED: …]`), so extract STRUCTURE — tag/class trees, form field NAMES, URL path + param KEYS — never raw HTML/values, and never log a captured password/cookie. Media is often a public CDN (fetchable server-side, no auth) whose `Last-Modified` header is a free per-item date when the HTML exposes none.

## Conventions (how chris likes them)

- **TDD, always.** Failing test → minimal code → green. Especially for write tools.
- **Verify endpoints before building them — at the right layer.** For no-API sites, capture the real request (DevTools → Network → "Copy as cURL", or a HAR) and pin the request *shape* in `docs/<SERVICE>-API.md`. Never code a write against an assumed body, and never encode a gate field you haven't seen succeed: confirm an actual successful artifact end-to-end (a real file/row), because downloads and navigations don't show up in XHR/`fetch`/HAR. Extract only the shape — **never commit captured cookies/tokens/signatures** (secret-scan before committing). **Premium APIs need a funded account to verify** — image/LLM endpoints (gemini-mcp's `gemini-3-pro-image`) return `429 … free_tier_requests, limit: 0` on a free key, so the verification gate is BLOCKED until the human enables billing; surface that and wait rather than guessing the shape. Also pin the SUCCESS response from a real 200 — request and response casing can differ (Gemini accepts snake_case `inline_data` on the request but returns camelCase `inlineData`), and a model/endpoint may only exist on `v1beta`, not `v1`. **Re-verify for EVERY new knob and especially every new/Beta endpoint, not just the first build** — a doc scrape (and a WebFetch summarized by a small model) is frequently wrong or incomplete: confirm each field name, accepted enum values, required headers (the Gemini Interactions API needs `Api-Revision: 2026-05-20`), and output constraints (it only accepts `image/jpeg`, not png) with a real call before coding. Cheap knobs (a new `imageSize` value, `thinkingConfig`, `seed`) are one curl each; a whole new endpoint earns a full request+response capture pinned in `docs/<SERVICE>-API.md`.
- **Confirm-gated writes.** Every mutating tool takes `confirm` (`schemaConfirm` from `zod`). Without `confirm: true` it makes **no** network call and returns a dry-run `preview()` of exactly what would be sent. Route every mutation through one private `client.write()` that attaches auth (cookie/CSRF or bearer) centrally.
- **Stream file uploads.** Never `readFileSync` a file just to wrap it in `new Blob([buf])` — use `fileBlob` / `readFileHead` from `@chrischall/mcp-utils` (or `fs.openAsBlob` directly) so a 20 MB upload isn't a 20 MB heap buffer.
- **Results:** `textResult(data)` for everything; errors via the typed `McpToolError` subclasses with an actionable `hint`.
- **Secrets:** `.env` gitignored; throwaway-test writes go only to blackholed addresses (`@example.com`); only the user's own account/data.
- **Never merge PRs or add `ready-to-merge` yourself.** Squash-merge is the default; `pr-auto-review` + `auto-merge` ship it. On a `warn`/`fail` verdict, surface the findings and ask — don't override.
- **Describe what it does, neutrally.** Public descriptions (`marketplace.json` `metadata.description`, `server.json`, the GitHub repo About) state the *mechanism* — e.g. "routes through the user's signed-in `<site>` tab via the fetchproxy bridge, reusing their authenticated session" — not bot-evasion framing ("to dodge bot detection"). Same factual tone as CLAUDE.md's "every request rides the user's own browser session."

## Repo bootstrap — git, labels, release-please

A new fleet repo isn't done until ALL of this exists. Each line below was a real failure when missing (CI red, review step erroring, `main` unprotected, bundle bloat).

**Workflows** (`.github/workflows/`, copy from a sibling): `ci.yml` (build+test), `pr-auto-review.yml` (Claude structured verdict → arms `ready-to-merge` on `pass` via `RELEASE_PAT`), `claude.yml` (`@claude` dispatch), `auto-merge.yml` (squash on `ready-to-merge`/dependabot), `release-please.yml` (publish: npm `--provenance` + `.mcpb` + MCP registry + ClawHub), `dependabot.yml`. **Node:** CI/publish `node-version: 26` (Current).

**Labels** — per-repo (`chrischall` is a *User* account: no org-wide labels/secrets). Create `auto-review`, `ready-to-merge`, `review-with-opus`, `autorelease: pending`, `autorelease: tagged`, plus dependabot categories (`ci`, `security`, `test`, `javascript`, `github_actions`, `ignore-for-release`). Missing `auto-review`/`ready-to-merge` → pr-auto-review's first step (`gh pr edit --add-label auto-review`) errors and arming can't happen.

**Branch protection** — two rulesets on `~DEFAULT_BRANCH` (personal account uses rulesets, not classic protection): (1) block `deletion` + `non_fast_forward`; (2) require a PR + the `ci` required status check.

**Repo setting: Allow auto-merge** — turn it on (`gh api -X PATCH repos/chrischall/<repo> -F allow_auto_merge=true`). This is separate from the workflow and the ruleset, and easy to miss: with it OFF, `auto-merge.yml`'s `gh pr merge --auto` silently fails to arm, so Dependabot / `ready-to-merge` PRs sit OPEN forever even with green CI. The workflow + `RELEASE_PAT` + `ci` ruleset are all necessary but NOT sufficient without this toggle. (Check the fleet: `gh api repos/chrischall/<repo> --jq .allow_auto_merge`.)

**Secrets** — per-repo, set by the **human** (an agent must never set credential values): `CLAUDE_CODE_OAUTH_TOKEN` (review), `RELEASE_PAT` (release-please + the auto-merge/arm step — a `GITHUB_TOKEN`-added label won't fire downstream workflows), optional `CLAWHUB_TOKEN`; plus npm **trusted publishing** for the `--provenance` publish.

**Claude GitHub App — install on the new repo (separate from the secrets).** `pr-auto-review.yml` posts its verdict as `claude[bot]` via the App's OIDC, and the **arm step reads that verdict to add `ready-to-merge`**. If the App isn't installed on the repo, the review job still runs and exits `success` but posts NOTHING and emits no `structured_output` — so the arm step reads `verdict=unknown` and never arms (PR sits green-but-open forever). The `CLAUDE_CODE_OAUTH_TOKEN` only authenticates the model, not repo posting. Human step: github.com/apps/claude → Configure → add the repo. Tell: zero `claude` PR comments = App not installed.

**release-please** — `release-please-config.json` (`package-name`, `release-type: node`, `changelog-sections`, `extra-files`) + `.release-please-manifest.json`. **`extra-files` MUST list every file that carries the version**, or `versionSyncTest` fails the release PR's CI: `manifest.json` `$.version`; `server.json` `$.version` + `$.packages[*].version`; `.claude-plugin/plugin.json` `$.version`; `.claude-plugin/marketplace.json` `$.plugins[*].version` + `$.metadata.version`; and **every `src/*.ts` with an `// x-release-please-version` marker**. **Prefer a single `src/version.ts`** (`export const VERSION = '…'; // x-release-please-version`) imported everywhere it's needed — one source, one extra-files entry, nothing to forget — rather than scattering the marker across `index.ts` + a `SERVER_VERSION` in `auth.ts`. Don't hand-bump; release-please does it.

**Publish scaffold** (also list in package.json `files`): `manifest.json` (mcpb; `runtimes.node` floor stays at an **LTS** like `>=22.5`, not 26, so LTS users install), `server.json` (registry; description **≤ 100 chars** or `mcp-publisher` 422s), `.claude-plugin/plugin.json` + `marketplace.json`, `.mcp.json`, `skills/<name>/SKILL.md`, and **`.mcpbignore`** so `mcpb pack` ships only `dist/bundle.js` + `manifest.json` + `package.json` — exclude `src/`, `tests/`, `docs/`, `node_modules/`, `.env*`, the registry/plugin manifests, **and** `release-please-config.json` / `.release-please-manifest.json` / `CHANGELOG.md`.

**mcp-publisher** — install via the shared pinned, SHA-256-verified action `chrischall/mcp-utils/.github/actions/install-mcp-publisher@<tag>`, NOT the upstream `releases/latest | tar xz` (that binary runs with the OIDC + RELEASE_PAT + CLAWHUB tokens).

## Gotchas (hard-won)

- **ESM + NodeNext**: every relative import ends in `.js`, even from `.ts`.
- **`"types": ["node"]`**: NodeNext repos need this in `tsconfig.compilerOptions` once they import a scoped pkg like `@chrischall/mcp-utils`, or `tsc` fails with `Cannot find name 'path'/'url'`. Add `types`, not `typeRoots`.
- **`tsconfig rootDir: "src"`** (not `"."`): with `rootDir:"."` + `include:["src"]`, `tsc` emits `dist/src/index.js` while `package.json` `bin` points at `dist/index.js`, so `npx <svc>` (and any host launching the bin) can't find its entry. Copying a sibling's tsconfig avoids this; a fresh scaffold gets it wrong.
- **The `.mcpb` bundle ships NO `node_modules` — an eager import of an esbuild-`--external` dep crashes it at LOAD.** A top-level `import { X } from 'pkg'` of an externalized/optional dep (e.g. `@fetchproxy/server` in `transport-fetchproxy.ts`) throws `ERR_MODULE_NOT_FOUND` the moment the host spawns the bundled server — before it answers `initialize` (the host logs "Server transport closed unexpectedly", not a useful error). Make optional/externalized deps **lazy**: `import type { X } from 'pkg'` (type-only, erased) + `const { X } = await import('pkg')` inside the method that needs it, so the default path never touches it. `loadDotenvSafely`'s guarded import already does this for `dotenv`; do the same for `@fetchproxy/server` in any cookie-session/bearer repo that keeps fetchproxy as an optional fallback.
- **Add a server-boot smoke test** (`tests/server-boot.test.ts`): spawn the REAL built artifacts — `dist/bundle.js` in a temp dir with NO `node_modules` (the `.mcpb` runtime) and the `bin` `dist/index.js` WITH them — run the `initialize` + `tools/list` handshake, and assert the tools list. Catches both the eager-import crash above and a wrong `bin` path, which unit tests (mocking everything) never see. **Assert `tools.length >= N`, not an exact count** — PR CI runs the branch MERGED with `main`, so a hardcoded `toHaveLength` breaks the instant another PR adds a tool; let `index.test.ts` own the exact roster on its own branch.
- **zod 4**: mcp-utils peer-requires `zod@^4.4.0`. Repos still on zod 3 must bump (schemas are compatible; `z.string().email()` is deprecated-but-works).
- **Never commit secrets**: `.env` must be gitignored. Real creds live in `.env` (local) or the MCP host's `mcp_config.env`. If `.env` is tracked, `git rm --cached` it.
- **Version sync**: version is duplicated across `package.json`, `src/index.ts` (`x-release-please-version` marker), `manifest.json`, `server.json`, `.claude-plugin/*`. Keep them equal — `versionSyncTest` from `/test` guards it. Don't hand-bump; release-please / the Tag-&-Bump action does it.
- **`server.json` description ≤ 100 chars** (MCP registry schema) — over that, `mcp-publisher publish` 422s.
- **Private repo + npm provenance don't mix.** `npm publish --provenance` (the fleet default — sigstore attestation) only works from a **public** GitHub repo. A private repo 422s at the npm step: *"Unsupported GitHub Actions source repository visibility: 'private'. Only public source repositories are supported when publishing with provenance."* So for a private / personal MCP, pick one: (a) keep it unpublished — `"private": true` in `package.json` + remove the `publish` job from `release-please.yml` (release-please can still own version bumps + tags + the `.mcpb`/GitHub release), (b) drop `--provenance` from the `npm publish` step (you lose the attestation; a public *scope* still publishes fine via `--access public`), or (c) make the repo public. Don't leave the default `--provenance` publish wired on a private repo — every release fails.
- **npm name: check it FIRST, and scope when it's contested.** Good unscoped MCP names are squatted (`gemini-mcp`, `nano-banana-mcp`, `nano-banana-pro-mcp` all taken at 1.x), and even an *available* unscoped name can be **rejected at `npm publish` for being "too similar" to an existing package** (`gemini-image-mcp` collides with `mcp-gemini-image`) — `npm view` shows it free but publish 422s. `npm view <name> version` only proves it's unpublished, NOT publishable. Fix: **publish under the `@chrischall` scope** (`@chrischall/gemini-mcp`) — scoped names are exempt from the similarity check, same as `@chrischall/mcp-utils`. Only the npm-publish identity needs the scope: `package.json` `name` + `publishConfig.access:"public"`, `server.json` `packages[].identifier`, release-please `package-name`, and the install/`npx` commands. Keep `bin`, `mcpName`/`server.json` registry name (`io.github.chrischall/<repo>`), the `.claude-plugin` names, and the repo itself UNSCOPED so the whole identity stays one word. Decide the name (and `gh repo create`) only after `npm view` + a scope decision — renaming a repo + local dir + every manifest afterward is avoidable churn.
- **Re-running `pr-auto-review` does NOT re-arm; trigger a fresh PR event.** `gh run rerun` re-executes the review job but `claude-code-action` does not regenerate `structured_output` on a rerun (the "Surface verdict" step shows `skipped`), so the arm step falls back to `verdict=unknown` and won't add `ready-to-merge`. To get a clean verdict + arm, fire a fresh `pull_request` event — `gh pr close <n> && gh pr reopen <n>` (or a push) — not a workflow rerun.
- **stdio transport**: logs go to **stderr only** — stdout is reserved for JSON-RPC.
- **Don't merge PRs**: open with one release-notes label; `pr-auto-review` + `auto-merge` ship it. Never add `ready-to-merge` yourself to override a warn/fail.
- **Auto-merge ships a PR out from under you — one complete commit, no follow-ups.** `pr-auto-review` + `auto-merge` squash-merge a PR the moment its review flips to `pass` (often < 1 min after opening). Any commit you push to the branch AFTER that lands on a now-stale branch and **orphans — it never reaches `main`** (this keeps biting: a "one more line" follow-up push silently vanishes). So open a PR only when the change is COMPLETE in a single push; never use a PR branch as a staging area for follow-ups. Left something out? Verify it actually landed (`git branch -r --contains <sha> | grep origin/main`), then it's a NEW branch + PR — not another push to the merged one. Need a real checkpoint without shipping? Open it `--draft` (auto-review skips drafts).
- **A prior PR squash-merging out from under you leaves your follow-up branch with DUPLICATE commits — replay onto fresh `main`, don't PR the stale branch.** If you keep committing locally on `feat/X` while PR #N (off the same base) auto-merges, your branch's merge-base is now behind `main`, and `main` holds ONE squash commit while your branch still has the original individual commits of that merged work. Opening a PR from it (or pushing) re-creates a deleted branch and offers a diff full of already-merged churn. Recovery: `git fetch`; branch off current `origin/main`; replay ONLY the genuinely-new commits — `git rebase --onto origin/main <last-already-merged-sha>` (or `git checkout -b feat/X2 origin/main && git cherry-pick <last-merged-sha>..HEAD`); the cherry-picks apply cleanly because the squash's tree == the last-merged commit's tree. Then `git push origin --delete <stale-branch>` and open the PR from the clean one. (Confirms: `git log --oneline origin/main..HEAD` should show ONLY your new commits.)
- **Parallel feature PRs collide on `index.ts` + `index.test.ts`** — the tool-registrar list and the tool-count/sorted-roster are serial conflict magnets. Branch each feature off `main` (don't stack PRs — a squash-merge gives the parent a new SHA and the stacked branch then carries a duplicate of it), and expect to **rebase the second PR** after the first merges: `git reset --hard origin/main` + cherry-pick the feature commit (or `git rebase origin/main`), union-merge the two registrars, bump the count. Trivial, but it WILL conflict — don't be surprised.

## New MCP — fast path

0. **Lock the name before creating anything.** `npm view <name> version` for each candidate (and watch the similarity trap — see Gotchas); if contested, publish under `@chrischall/<name>`. Settle repo name + npm name together, THEN `gh repo create` — renaming later cascades across the repo, local dir, and every manifest.
1. Copy a same-archetype sibling's skeleton (splitwise for bearer, redfin for fetchproxy) — including its `.github/`, packaging, tsconfig, vitest. Then do the full **Repo bootstrap** (workflows, labels, rulesets, secrets + **Claude GitHub App install**, release-please extra-files, publish scaffold, `.mcpbignore`) — it's the part that's easy to half-do.
2. Add `"@chrischall/mcp-utils"` (published `^x` once available; `file:../mcp-utils/<tarball>` pre-publish).
3. Write `client.ts` (deferred-config-error + one central `write()`), `tools/*.ts` (`registerTool` + `textResult`, **`confirm`-gated** writes with a dry-run `preview()`), wire `index.ts` with `runMcp`. TDD; verify endpoints from a capture before coding writes.
4. Tests with `createTestHarness` + `versionSyncTest`; mock the network. Keep them green.
5. `npm run build && npm test`. Branch + PR; let auto-merge ship it (never merge it yourself).
