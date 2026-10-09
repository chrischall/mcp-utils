# Migrating to @chrischall/mcp-utils 3.0

3.0 ships the hardening from #361. Most of it is additive: new helpers, new
options, warn-only lint checks. Three changes break callers, and they are why
this is a major release.

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

## 3. `confirmationFromEnv` requires `account` and `args`

**Before:** both were optional. A server could mint a confirm token bound to
neither the account it acts as nor the arguments it will send, and an
elicitation acceptance bound to nothing at all. That is the root cause of
fleet-audit #979, #986, #1066, #1072, #1086, #1089 and #1098.

**Now:** both are required keys of `ConfirmationFromEnvOptions`, matching
`confirmWrite`'s rule for `account`:

- `account: string | undefined` — the principal the action runs as. On a
  single-account server write `account: undefined`; the key must be there, so
  forgetting it is a compile error rather than an unbound token.
- `args: object` — the tool's validated arguments, as the handler received them
  (a `confirmToken` key is dropped for you). A tool with no arguments passes
  `{}`. `undefined` or `null` throws a `TypeError` at runtime too.

Both rails bind both: the token carries the account in its claims and hashes
`{ payload: subject().payload, args }`; the elicitation acceptance is
HMAC-bound to `{ account, args }`. A token or acceptance minted for one account
or one set of arguments is refused (`TOKEN_INVALID` / `DRAFT_CHANGED`) or asked
again for any other.

```ts
// before
const gate = await requireConfirmationWithFallback(ctx, confirmationFromEnv({
  action: 'thing.delete', message: 'Review and confirm this deletion.', details: { id },
  tool: 'thing_delete', confirmToken,
  subject: () => ({ target: id, payload: { id }, preview: { id } }),
}));

// after: name the account (or say there is none) and bind the arguments
server.registerTool('thing_delete', { /* … */ }, async (args, ctx) => {
  const { id, confirmToken } = args;
  const gate = await requireConfirmationWithFallback(ctx, confirmationFromEnv({
    action: 'thing.delete', message: 'Review and confirm this deletion.', details: { id },
    tool: 'thing_delete', confirmToken,
    account: client.accountId,        // or `account: undefined` on a single-account server
    args,                             // the validated input; `{}` for a tool with none
    subject: () => ({ target: id, payload: { id }, preview: { id } }),
  }));
  if (gate) return gate;
  // …
});
```

`confirmWrite` callers need no change: it already required `account`, and it
passes both through. If a tool is a plain HTTP or payload write, moving it to
`confirmWrite` is the simplest fix.

Tokens issued by a 2.x server (or an elicitation acceptance in flight across
the upgrade) are refused once and the user is asked again; nothing is written
on a stale approval.

## Upgrading

Bump with a `fix(deps):` PR (first-party bumps ship, they are not chores), run
the repo's CI test command (including its typecheck: the new required keys are
compile errors, not test failures), and grep for `resolveOutputDir(`,
`RequestTimeoutError` and `confirmationFromEnv(`.
