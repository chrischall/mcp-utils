# Migrating to @chrischall/mcp-utils 3.0

3.0 ships the hardening from #361. Most of it is additive: new helpers, new
options, warn-only lint checks. Two behaviour changes break callers, and they
are why this is a major release.

## 1. `resolveOutputDir` no longer falls back to the working directory

**Before:** with no per-call directory and the env var unset, it returned
`process.cwd()`. Under Claude Desktop or an `.mcpb` that is `/`, so the write
failed. Under Claude Code it is the user's repository, so files landed in it.

**Now:** the order is per-call dir, then the env var, then
`~/Downloads/<name>` (created with mode 0700) **only when you pass
`{ name }`**. Without `name`, it throws an `McpToolError` naming the env var.

```ts
// before
const dir = resolveOutputDir(args.outputDir, 'FOO_OUTPUT_DIR');
// after: pass your server's name to keep a working default
const dir = resolveOutputDir(args.outputDir, 'FOO_OUTPUT_DIR', { name: 'foo-mcp' });
```

## 2. A timed-out write throws `WriteOutcomeUnknownError`

**Before:** `createApiClient` threw `RequestTimeoutError` for every timeout.

**Now:** a timeout or network failure on a non-safe request (anything but
GET/HEAD/OPTIONS/TRACE) throws `WriteOutcomeUnknownError`, an `McpToolError`.
Its hint tells the model the write may have happened, so it should not resend
blindly. Reads still throw `RequestTimeoutError`.

Two opt-outs: mark a request that is safe to repeat with `{ idempotent: true }`,
or restore the old behaviour for a whole client with
`createApiClient({ writeOutcomeUnknown: false })`.

```ts
// before
if (err instanceof RequestTimeoutError) { /* … */ }
// after: handle both if you catch around writes
if (err instanceof WriteOutcomeUnknownError || err instanceof RequestTimeoutError) { /* … */ }
```

If you only rethrow, nothing changes for you: the new error already carries
the right hint.

## Upgrading

Bump with a `fix(deps):` PR (first-party bumps ship, they are not chores), run
the repo's CI test command, and grep for `resolveOutputDir(` and
`RequestTimeoutError`.
