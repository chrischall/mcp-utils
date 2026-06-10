# @chrischall/mcp-utils

Shared scaffolding for the **chrischall MCP fleet** — the generic MCP glue
hoisted out of ~19 sibling servers so each one no longer reimplements server
bootstrap, tool-result formatting, helpful errors, hardened env/config, a bearer
API-client kit, zod atoms, session registries, a fetchproxy transport adapter,
auth resolver skeletons, an in-memory test harness, and opt-in HTML helpers.

```sh
npm install @chrischall/mcp-utils
```

Peer dependencies: `@modelcontextprotocol/sdk` and `zod`. The `@fetchproxy/server`
and `node-html-parser` peers are **optional** — only needed if you import the
`/fetchproxy` or `/html` subpaths respectively. Their declared range is `*` so a
consumer pinning any version installs cleanly; the real requirement is enforced
at the subpath: **`/fetchproxy` needs `@fetchproxy/server` >= 0.11** (it
re-exports APIs added there — `withDeadline`, `backoffDelayMs`, `BRIDGE_CONCURRENCY`,
the bridge-error classifier). MCPs on older `@fetchproxy/server` can use the core
barrel freely; adopt `/fetchproxy` only after bumping to 0.11+.

## Entry points

The core building blocks are re-exported from the package root. Heavier or
optional-dependency modules are published as **subpath entries** to keep the core
import light:

| Import | Contents |
| --- | --- |
| `@chrischall/mcp-utils` | core barrel: `server` + `response` + `errors` + `config` + `fs` + `http` + `zod` + `auth` |
| `@chrischall/mcp-utils/session` | session registry, session store, token manager, cookie-session manager |
| `@chrischall/mcp-utils/fetchproxy` | fetchproxy transport adapter, bot-wall / retry / concurrency helpers |
| `@chrischall/mcp-utils/html` | opt-in HTML scraping helpers (needs `node-html-parser`) |
| `@chrischall/mcp-utils/test` | in-memory test harness for tool registration |

```ts
import { createMcpServer, textResult, requireEnvVar } from '@chrischall/mcp-utils';
import { createSessionRegistry } from '@chrischall/mcp-utils/session';
import { createFetchproxyTransport } from '@chrischall/mcp-utils/fetchproxy';
```

## Modules

### `server` — bootstrap & lifecycle

`createMcpServer`, `runMcp`, `withGracefulShutdown`.

```ts
import { runMcp, textResult } from '@chrischall/mcp-utils';

await runMcp({
  name: 'my-mcp',
  version: '1.0.0',
  register: (server) => {
    server.tool('ping', {}, async () => textResult({ ok: true }));
  },
  // shutdown: { onSignal: () => client.close() },
});
```

`runMcp` wires the server to a stdio transport and installs `SIGINT`/`SIGTERM`
handlers via `withGracefulShutdown`. Use `createMcpServer` directly if you need
the server instance without connecting a transport.

### `response` — tool-result formatting

`textResult` / `jsonResult` (alias), `rawTextResult`, `imageResult`,
`errorResult`, `flattenJsonApi`, `deepMapStringField`.

```ts
import { textResult, errorResult, flattenJsonApi, deepMapStringField } from '@chrischall/mcp-utils';

return textResult({ items });                 // pretty-printed JSON
return errorResult('not found');              // { isError: true }
return textResult(flattenJsonApi(payload));   // collapse JSON:API envelopes

// Rewrite a string field throughout a response (e.g. normalize a date format):
deepMapStringField(payload, 'eventDate', dmyToIso);
```

### `errors` — helpful errors

`McpToolError` and its subclasses (`SessionNotAuthenticatedError`,
`BotWallError`, `RateLimitError`, `UnreachableError`, `ModeMismatchError`),
plus `createHelpfulError`, `wrapToolError`, `truncateErrorMessage`,
`redactSecrets`, and `messageOf`. `redactSecrets` scrubs `Bearer`/`Basic` auth
headers, `Cookie`/`Set-Cookie` values (cookie names stay visible), JWTs,
well-known API-key shapes (`sk-…`, `ghp_…`, `xox?-…`, `AIza…`, `AKIA…`,
`whsec_…`), and secret-bearing URL query params; `truncateErrorMessage` applies
it before truncating, and `errorResult` applies it (without truncating). This core module has **no runtime dependencies** — the fetchproxy
typed-error hierarchy (`Fetchproxy*Error`), the raw `classifyBridgeError` /
`classifyRowError` re-exports, and the `bridgeErrorInfo` envelope helper live in
the [`/fetchproxy`](#fetchproxy) subpath instead, so
bearer-only MCPs can import the core barrel without installing
`@fetchproxy/server`.

```ts
import { wrapToolError, SessionNotAuthenticatedError } from '@chrischall/mcp-utils';

try {
  if (!token) throw new SessionNotAuthenticatedError({ hint: 'run the login tool first' });
} catch (err) {
  throw wrapToolError('my_tool', err);
}
```

Every error carries an optional `hint` — a "here's how to fix it" string the
tool surface can show the user.

### `config` — hardened env/config

`readEnvVar`, `requireEnvVar`, `parseBoolEnv`, `readPortEnv`, `expandPath`,
`loadDotenvSafely`, `createCachedJsonArrayLoader`.

```ts
import { requireEnvVar, parseBoolEnv, readPortEnv, expandPath } from '@chrischall/mcp-utils';

const apiKey = requireEnvVar('MY_API_KEY');
const debug = parseBoolEnv('MY_DEBUG', { default: false });
const port = readPortEnv('MY_WS_PORT', 37149);  // placeholder/NaN/out-of-range → fallback
const home = expandPath('~/.config/my-mcp');
```

`readPortEnv` parses a TCP port with the same placeholder hardening as
`readEnvVar`, plus integer + `1..65535` range validation — so an unexpanded
`${MY_WS_PORT}` or junk falls back to the default instead of handing `NaN` to
the server.

`loadDotenvSafely` is a no-throw `.env` loader (returns `false` instead of
failing when the file is absent).

`createCachedJsonArrayLoader` builds a cached, negative-cached loader for an
env-named JSON string-array file — the `loadCommunities`/`DEFAULT_COMMUNITIES`
pattern shared across the realty servers:

```ts
import { createCachedJsonArrayLoader } from '@chrischall/mcp-utils';

const loadCommunities = createCachedJsonArrayLoader({
  envVar: 'REDFIN_COMMUNITIES_FILE',  // path to a JSON string-array file
  defaults: DEFAULT_COMMUNITIES,      // returned when unset/missing/invalid
  label: 'redfin-mcp',
});

const communities = loadCommunities();  // parses + caches; re-reads only on path change
```

A successful parse is cached; a missing/unreadable file, invalid JSON, or a
non-string-array logs one stderr warning and negative-caches (returns defaults
without re-reading). Pass `readFile` to inject a reader in tests.

### `fs` — streaming file helpers (uploads)

`fileBlob`, `readFileHead`.

```ts
import { fileBlob, readFileHead } from '@chrischall/mcp-utils';

// A file-backed Blob: fetch streams it from disk, never buffered in memory.
const blob = await fileBlob(path, { type: 'image/jpeg', maxBytes: 20_000_000, label: 'Image' });
const form = new FormData();
form.append('file', blob, 'photo.jpg');

// Sniff a header (image dimensions, magic bytes) without reading the whole file.
const head = await readFileHead(path, 65_536);
```

Use `fileBlob` in place of `new Blob([readFileSync(path)])` for `FormData` uploads
— `fs.openAsBlob` backs the Blob with the file on disk, so a 20 MB upload uses
constant memory instead of a 20 MB Buffer.

### `http` — bearer API-client kit

`createApiClient` plus building blocks: `buildQueryString`, `buildOptionalBody`,
`formatApiError`, `parseLinkHeader`, `parseCookieJar`, `parseCookieHeader`,
`runBoundedBatch`, JWT helpers (`decodeJwtExp`, `decodeJwtSessionId`,
`decodeJwtClaim`, `validateJwtExpiry`), and the `ApiError` / `UpstreamHttpError` /
`UnauthorizedError` / `RateLimitedError` / `RequestTimeoutError` classes.

`decodeJwtClaim(token, claim)` is the generic single-claim reader — returns the
raw claim value (`unknown`) or `undefined` for an undecodable token / absent
claim, so a repo doesn't hand-roll its own `extractXFromJwt`.

```ts
import { createApiClient } from '@chrischall/mcp-utils';

const api = createApiClient({
  baseUrl: 'https://api.example.com',
  getToken: () => store.currentToken(),  // resolved per-request; sync or async
  serviceName: 'Example',
  retry: { count: 1, delayMs: 2000 },    // fleet-wide "retry once after 2s" default
  timeout: 15_000,                        // abort a hung request, throw RequestTimeoutError
});

const data = await api.get('/v1/things', { query: { page: 2 } });
```

`timeout` (ms) bounds each attempt with an `AbortController`; on expiry it throws
`RequestTimeoutError` instead of hanging the tool call. A 429 retry gets a fresh
timeout. Omit it to keep the previous unbounded behavior.

`parseCookieHeader(header)` parses an inbound *request* `Cookie:` header
(`name=value; name2=value2`) into a `Record<string, string>` (first `=` splits,
so values may contain `=`; last value wins on a duplicate name). It's the
counterpart to `parseCookieJar`, which parses *response* `Set-Cookie` headers
with their attributes and deletion semantics.

`UpstreamHttpError(status, message)` is a directly-`throw new`-able,
status-carrying HTTP error — the manual-throw parallel to `ApiError` (which
`createApiClient` throws internally). It `extends ApiError`, so both the
`err instanceof ApiError && err.status === 404` branch and a narrower
`instanceof UpstreamHttpError` check work. Use it from a transport/bridge code
path that doesn't route through `createApiClient` but still needs to branch on a
404.

```ts
import { runBoundedBatch } from '@chrischall/mcp-utils';

const rows = await runBoundedBatch(ids, (id, signal) => fetchRow(id, signal), {
  deadlineMs: 45_000,                        // overall hard deadline for the whole batch
  concurrency: 4,                            // optional fan-out cap
  onTimeout: (id, i) => ({ id, pending: true }), // backfill any row the deadline cut off
});
```

`runBoundedBatch(items, worker, opts)` races the whole batch against one overall
`deadlineMs`; any item still unsettled when it fires is filled by
`onTimeout(item, index)` (and its worker abandoned + `AbortSignal`-signalled) so
a single hung row can't wedge the call. It always returns a full-length,
input-ordered array. `setTimer`/`clearTimer` are injectable for tests. This
hoists zillow's bulk-tool deadline + `pending`-backfill primitive.

### `dates` — date-format converters

`isoToDmy`, `dmyToIso`, `isoToCompactTimestamp`. For upstreams that don't speak
ISO 8601, so a server can keep its surface ISO (`yyyy-MM-dd`) and translate at
the API boundary. Pair with `deepMapStringField` to normalize a date field
across a whole response.

```ts
import { dmyToIso, isoToDmy, deepMapStringField } from '@chrischall/mcp-utils';

const apiDate = isoToDmy('2025-08-28');                 // '28-08-2025' (request)
deepMapStringField(payload, 'eventDate', dmyToIso);     // '28-08-2025' → '2025-08-28' (response)
```

### `zod` — schema atoms

Reusable schemas (`PositiveInt`, `NonNegInt`, `NonEmptyString`, `IsoDate`,
`IsoTime`, `NumericIdString`, `SafePathSegment`, `schemaOrigin`,
`schemaConfirm`), pagination helpers
(`paginationSchema`, `pageSchema`, `calculateOffset`), tool-annotation builders
(`toolAnnotations`), and time normalizers (`extractTime`, `normalizeTime`).

```ts
import { paginationSchema, calculateOffset, toolAnnotations } from '@chrischall/mcp-utils';

const inputSchema = { ...paginationSchema, q: NonEmptyString };
const offset = calculateOffset(page, size);
const annotations = toolAnnotations({ readOnly: true });
```

`NumericIdString` (`/^\d+$/`) and `SafePathSegment` (rejects `/`, `..`, `?`,
`#`, and whitespace) harden caller-supplied ids that get interpolated into
request paths — defense-in-depth against path traversal and query/fragment
injection.

### `auth` — auth resolver skeletons

`createAuthResolver`, `resolveAuthPattern`, `sessionLoginFlow`,
`createOAuth2Refresher`, and the supporting `FetchproxySession` /
`AuthPattern` types.

```ts
import { createAuthResolver, createOAuth2Refresher } from '@chrischall/mcp-utils';

const resolver = createAuthResolver({ /* ... */ });
const refresh = createOAuth2Refresher({ /* ... */ });
```

### `session` — session registry, token manager & cookie-session manager *(subpath)*

```ts
import {
  createSessionRegistry,
  registerSessionTools,
  TokenManager,
  CookieSessionManager,
} from '@chrischall/mcp-utils/session';

const registry = createSessionRegistry();
registerSessionTools(server, { registry /* ... */ });
```

Includes `SessionStore`, `normalizeOrigin`, `AuthMode`, and `TokenManager`
(with `TOKEN_REFRESH_SKEW_MS` for proactive refresh).

`CookieSessionManager<S, R = Response>` is the cookie-session analog of
`TokenManager` for sites authenticated by a browser-style cookie session rather
than a bearer token. It owns *when* to log in (single-flight, so concurrent
callers coalesce into ONE login), clears the in-flight promise on settle (a
rejected login never sticks — the next `ensure()` retries), and `withSession()`
re-logs-in and replays a request **exactly once** on a detected expiry (no
infinite loop). The injected `isExpired(res)` predicate is the hook for body/URL
heuristics — so a `200` serving an HTML login page or a redirect away from the
target is treated as expired, not just `401`/`403`. An optional
`isPermanentError` caches genuine missing-config errors while leaving transient
login failures retryable.

`isExpired` is **optional** — omit it for ensure-only consumers with no
per-request expiry path (e.g. Skylight, whose re-auth lives in `TokenManager`);
it defaults to `() => false`, so `withSession()` simply never replays.

The second type param `R` (default `Response`) is the response type
`withSession`'s `call` resolves to. The manager is response-agnostic — it only
hands `R` to `isExpired` and returns it untouched — so override `R` for a custom
or non-fetch transport (e.g. Artsonia's `{ setCookie?, location?, url, body }`).
Existing adopters writing `CookieSessionManager<MySession>` keep `R = Response`
with **no call-site changes**.

```ts
const sessions = new CookieSessionManager<{ cookieHeader: string; csrfToken?: string }>({
  login: () => loginWithPassword(),                 // mints a fresh cookie session
  isExpired: async (res) =>
    res.status === 401 || /<form[^>]*id="login"/i.test(await res.clone().text()),
});

const res = await sessions.withSession((s) =>
  fetch(url, { headers: { cookie: s.cookieHeader } }),
);

// Custom non-fetch transport: parameterize R (and isExpired reads R's members).
const custom = new CookieSessionManager<MySession, MyResponse>({
  login: () => loginWithPassword(),
  isExpired: (res) => /login\.asp/i.test(res.location ?? res.url),
});
```

Replaces the hand-rolled re-login / single-flight / 401-replay code in
`artsonia-mcp`, `canvas-parent-mcp`, `evite-mcp`, `signupgenius-mcp`, and
`skylight-mcp`.

### `fetchproxy` — transport adapter *(subpath, optional peer)*

```ts
import {
  createFetchproxyTransport,
  createBootstrapOpts,
  registerBridgeHealthcheckTool,
  mapWithConcurrency,
  TokenBucket,
  classifyBotWall,
} from '@chrischall/mcp-utils/fetchproxy';
```

Wraps `@fetchproxy/server` with the fleet's transport, bot-wall classification,
deadline/retry, token-bucket rate limiting, and bounded-concurrency helpers, and
re-exports the fetchproxy typed-error hierarchy.

**Transport verb adapters.** Beyond the `start` / `close` / `status` lifecycle,
`createFetchproxyTransport` exposes the verb passthroughs redfin / homes /
compass / musescore had each hand-rolled over the server:

- `fetch(init)` → `{ status, body, url }` via `server.request(...)`;
- `requestJson(method, path, init?)` → `{ data, result }` via
  `server.requestJson(...)` (serialization + header defaults + 204→null +
  `JSON.parse`; the caller keeps its per-site `throwIfNotOk` over `result`);
- `runProbe(fetchFn, probePath)` → the healthcheck probe loop.

The one per-site bit is the subdomain: pass `defaultSubdomain: 'www'` for sites
served from `www` (redfin/homes/compass); omit it for apex-served sites
(musescore). A per-call `subdomain` always overrides the default, and absolute
`http(s)://` paths self-describe their host. Other per-site verbs (e.g.
musescore's `download` capability) stay caller-supplied — the factory covers the
common subset, not the long tail.

**Bridge-healthcheck tool factory.** `registerBridgeHealthcheckTool({ server,
prefix, probePath, hostLabel, transport, probeFn })` registers a
`<prefix>_healthcheck` tool that round-trips `probePath` through the bridge and
reports bridge role / port / timing plus an actionable hint ladder
(`bridge_down` → wake the SW, `role === null` → check startup, `timeout` →
extension not connected, …). The failure hint cites the **actual configured
bridge port** from `bridgeHealth()`, not a hardcoded `37149` — fixing the bug
the per-site compass + musescore copies shared.

```ts
registerBridgeHealthcheckTool({
  server,
  prefix: 'compass',
  probePath: '/robots.txt',
  hostLabel: 'compass.com',
  transport,
  probeFn: (path) => client.fetchHtml(path),
});
```

### `html` — scraping helpers *(subpath, optional peer)*

```ts
import {
  parsePropertyTable,
  findLinksUnderHeading,
  extractJsonFromHtml,
  extractPlainTextFromHtml,
} from '@chrischall/mcp-utils/html';
```

Requires the optional `node-html-parser` peer. Also provides `urlToPath`,
`locationToSlug`, and `buildIdExtractor`.

### `test` — in-memory test harness *(subpath)*

```ts
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';

const harness = createTestHarness();
register(harness.server);
const result = await harness.call('ping', {});
expect(parseToolResult(result)).toEqual({ ok: true });
```

Also includes `versionSyncTest`, `mockFetchproxyBootstrap`, `setupClientMocks`,
and `makeBootstrapResult`.

## Shared CI actions

This repo also hosts composite GitHub Actions the MCP fleet reuses, under
[`.github/actions/`](.github/actions/):

- [`install-mcp-publisher`](.github/actions/install-mcp-publisher) — download a
  **pinned, SHA-256-verified** `mcp-publisher` binary (the registry-publish CLI)
  onto `PATH`, instead of the upstream unverified `releases/latest | tar xz`. Fleet
  release workflows reference it by tag so the pinned version bumps in one place:

  ```yaml
  - uses: chrischall/mcp-utils/.github/actions/install-mcp-publisher@v0.2.1
  - run: mcp-publisher login github-oidc
  - run: mcp-publisher publish
  ```

## Development

```sh
npm run build      # tsc -b → dist/
npm test           # vitest run
npm run test:watch # vitest (watch mode)
```

## License

MIT
