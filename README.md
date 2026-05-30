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
`/fetchproxy` or `/html` subpaths respectively.

## Entry points

The core building blocks are re-exported from the package root. Heavier or
optional-dependency modules are published as **subpath entries** to keep the core
import light:

| Import | Contents |
| --- | --- |
| `@chrischall/mcp-utils` | core barrel: `server` + `response` + `errors` + `config` + `http` + `zod` + `auth` |
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
`errorResult`, `flattenJsonApi`.

```ts
import { textResult, errorResult, flattenJsonApi } from '@chrischall/mcp-utils';

return textResult({ items });                 // pretty-printed JSON
return errorResult('not found');              // { isError: true }
return textResult(flattenJsonApi(payload));   // collapse JSON:API envelopes
```

### `errors` — helpful errors

`McpToolError` and its subclasses (`SessionNotAuthenticatedError`,
`BotWallError`, `RateLimitError`, `UnreachableError`, `ModeMismatchError`),
plus `createHelpfulError`, `wrapToolError`, `truncateErrorMessage`, and
`messageOf`. This core module has **no runtime dependencies** — the fetchproxy
typed-error hierarchy (`Fetchproxy*Error`) and the `classifyBridgeError`
discriminator live in the [`/fetchproxy`](#fetchproxy) subpath instead, so
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

### `http` — bearer API-client kit

`createApiClient` plus building blocks: `buildQueryString`, `buildOptionalBody`,
`formatApiError`, `parseLinkHeader`, `parseCookieJar`, JWT helpers
(`decodeJwtExp`, `decodeJwtSessionId`, `validateJwtExpiry`), and the
`UnauthorizedError` / `RateLimitedError` classes.

```ts
import { createApiClient } from '@chrischall/mcp-utils';

const api = createApiClient({
  baseUrl: 'https://api.example.com',
  getToken: () => store.currentToken(),  // resolved per-request; sync or async
  serviceName: 'Example',
  retry: { count: 1, delayMs: 2000 },    // fleet-wide "retry once after 2s" default
});

const data = await api.get('/v1/things', { query: { page: 2 } });
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

## Development

```sh
npm run build      # tsc -b → dist/
npm test           # vitest run
npm run test:watch # vitest (watch mode)
```

## License

MIT
