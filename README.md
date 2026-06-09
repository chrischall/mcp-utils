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
| `@chrischall/mcp-utils/session` | session registry, session store, token manager |
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

`readEnvVar`, `requireEnvVar`, `parseBoolEnv`, `expandPath`, `loadDotenvSafely`.

```ts
import { requireEnvVar, parseBoolEnv, expandPath } from '@chrischall/mcp-utils';

const apiKey = requireEnvVar('MY_API_KEY');
const debug = parseBoolEnv('MY_DEBUG', { default: false });
const home = expandPath('~/.config/my-mcp');
```

`loadDotenvSafely` is a no-throw `.env` loader (returns `false` instead of
failing when the file is absent).

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
`validateJwtExpiry`), and the `ApiError` / `UpstreamHttpError` /
`UnauthorizedError` / `RateLimitedError` / `RequestTimeoutError` classes.

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
`IsoTime`, `schemaOrigin`, `schemaConfirm`), pagination helpers
(`paginationSchema`, `pageSchema`, `calculateOffset`), tool-annotation builders
(`toolAnnotations`), and time normalizers (`extractTime`, `normalizeTime`).

```ts
import { paginationSchema, calculateOffset, toolAnnotations } from '@chrischall/mcp-utils';

const inputSchema = { ...paginationSchema, q: NonEmptyString };
const offset = calculateOffset(page, size);
const annotations = toolAnnotations({ readOnly: true });
```

### `auth` — auth resolver skeletons

`createAuthResolver`, `resolveAuthPattern`, `sessionLoginFlow`,
`createOAuth2Refresher`, and the supporting `FetchproxySession` /
`AuthPattern` types.

```ts
import { createAuthResolver, createOAuth2Refresher } from '@chrischall/mcp-utils';

const resolver = createAuthResolver({ /* ... */ });
const refresh = createOAuth2Refresher({ /* ... */ });
```

### `session` — session registry & token manager *(subpath)*

```ts
import {
  createSessionRegistry,
  registerSessionTools,
  TokenManager,
} from '@chrischall/mcp-utils/session';

const registry = createSessionRegistry();
registerSessionTools(server, { registry /* ... */ });
```

Includes `SessionStore`, `normalizeOrigin`, `AuthMode`, and `TokenManager`
(with `TOKEN_REFRESH_SKEW_MS` for proactive refresh).

### `fetchproxy` — transport adapter *(subpath, optional peer)*

```ts
import {
  createFetchproxyTransport,
  createBootstrapOpts,
  mapWithConcurrency,
  TokenBucket,
  classifyBotWall,
} from '@chrischall/mcp-utils/fetchproxy';
```

Wraps `@fetchproxy/server` with the fleet's transport, bot-wall classification,
deadline/retry, token-bucket rate limiting, and bounded-concurrency helpers, and
re-exports the fetchproxy typed-error hierarchy.

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
