# What MCP clients actually do

A measured record, not a reading of the spec. Every row here was observed,
and each says **when** and **from how much**, because all of it will drift.

Two sources, and the difference between them is the whole point of this file:

- **Telemetry** — `mcp-host`'s `usage_events`, which records what a client
  **sends**. Permanent, and re-queryable at any time (see *Re-running* below).
- **The probe** — `~/git/mcp-probe`, a throwaway connector registered as slug
  `probe`, which measures what a client **honours**. Nothing in the telemetry
  can answer that, and guessing it cost real work in September 2026.

## The clients

Measured 2026-09-21, from `meta.clientCapabilities` on `initialize`.

| client | version | declares |
| --- | --- | --- |
| `Anthropic/ClaudeAI` | 1.0.0 | `extensions` |
| `Anthropic/Toolbox` | 1.0.0 | **nothing at all** |
| `claude-code` | 2.1.278 | `elicitation`, `roots` |

Three surfaces, three answers. Anything conditioned on a capability must be
decided **per request**, never per deployment — and `undefined` must never be
read as `false`, because a 2025-era connection carries no envelope at all.

## What claude.ai SENDS

From ~10.6k requests in the week to 2026-09-20.

| | |
| --- | --- |
| 2026 routing headers (`Mcp-Method`/`Mcp-Name`) | **yes** — 10,595 of 10,595 |
| `server/discover` | **yes** — 2,894 calls |
| declared protocol revision | **`2025-06-18`** |
| `Mcp-Session-Id` | returned |
| `notifications/cancelled` | **yes** — 101 in the week |
| `resources/list` | yes — 37 calls |
| `resources/subscribe` | **no** — 0, against a server advertising it |
| `_meta.progressToken` | **effectively no** — 1 of 2,958 `tools/call` rows EVER, and that one was our own test |

It declares `2025-06-18` while sending 2026 routing headers: **2026 routing
over a 2025 session lifecycle.** Do not infer the revision from the headers.

## What claude.ai HONOURS

Probed 2026-09-21. This is the half telemetry cannot reach.

| we send | claude.ai |
| --- | --- |
| `destructiveHint: true` | **IGNORED** |
| `readOnlyHint: true` | no observable difference |
| an unannotated tool (spec default = destructive) | no observable difference |
| `structuredContent` + `outputSchema` | **never reaches the model** |
| `audio` block | **dropped**, replaced by a text notice |
| `resource_link` block | **dropped**, replaced by a text notice |
| `text` / `image` / embedded `resource` | delivered |
| `title` annotation | **stripped** — the model's schema has `name` and `description` only |
| `inputRequired` (elicitation) | refused, opaquely — see below |
| a registered prompt | `prompts/list` never called |

**The annotation result.** Four tools identical but for their annotations all
ran with no confirmation step, including the unannotated control. claude.ai's
own words: *"this interface didn't surface a distinct 'stop and ask' moment
for any of the four."*

**The structured-content result.** A probe returning `ANSWER=RED` as text and
`{answer: "BLUE"}` as structured content, with an `outputSchema` declared, was
read as `RED`. Emitting both costs result bytes on a metered host and is
discarded.

**Tool schemas are DEFERRED.** The model receives names, then must run a
`tool_search` to load parameters before it can call anything — observed
failing with *"'mcp__probe__probe_b_saw_red' has not been loaded yet"* and
recovering via a search. At fleet scale (434 tools across the gog servers
alone) **a description is discovery, not decoration**: a tool whose name and
description do not match how someone would search is effectively unreachable.

### There is no in-band human gate on claude.ai

Neither elicitation nor the annotation. A hosted MCP cannot make claude.ai
stop and ask. A preview→confirm token was scoped and declined (2026-09-21):
it is only an anti-*mistake* device, since a model that intends to send can
call both rounds, and the condition justifying it is the same one whose
reversal makes it unnecessary.

### The canonical failure string

```json
{"error": "Error occurred during tool execution", "request_id": "..."}
```

That is what a `requireConfirmation`-guarded tool looks like on a client with
no elicitation. Reproduced **verbatim** by a clean-room probe that does
nothing but return `inputRequired`, so the string is a symptom of the
elicitation gate and **not** of whatever the tool was doing. It cost three
days on `gog_gmail_forward` before that was known.

The refusal is raised **after the handler returns**, so a handler cannot
catch it. It must be predicted — which is what `callerAcceptsFormElicitation`
in the `caller` module is for.

## Spec defaults worth memorising

From `schema/2025-06-18/schema.ts`, `ToolAnnotations`:

| field | default |
| --- | --- |
| `readOnlyHint` | `false` |
| **`destructiveHint`** | **`true`** |
| `idempotentHint` | `false` |
| `openWorldHint` | `true` |

**An unannotated tool publishes as destructive.** Measured 2026-09-20 across
the eight gog servers: 434 tools → 162 read-only, **6 additive**, 266
destructive, with `gog_gmail_drafts_forward` — whose description begins
"SAVES ONLY. DOES NOT SEND" — raising the same alarm as `gog_gmail_send`.

## Three SDK gotchas, all SILENT

Against `@modelcontextprotocol/server` 2.0.0. None throws, so each costs a
debugging round:

- **The cancellation signal is `ctx.mcpReq.signal`, not `ctx.signal`.** `ctx`
  carries only `sessionId`/`mcpReq`/`http`; a probe reading `ctx.signal`
  concludes the SDK delivers no cancellation at all.
- **`ctx.mcpReq.notify` takes a notification OBJECT**, not `(method, params)`.
  Handed a string it spreads it character by character and puts
  `{"0":"n","1":"o",…}` on the wire, which the peer rejects — while the server
  sees a clean return.
- **The progress token is at `_meta`, not `meta`.** Reading `meta` yields
  `undefined`, the notification goes out well-formed but tokenless, and the
  client discards it as *"progress notification for an unknown token"*.

Because all three are invisible server-side, **test through a real `Client`**
(`InMemoryTransport.createLinkedPair`) and assert `client.onerror` stayed
empty. A unit test on the server cannot tell a delivered notification from a
dropped one.

## Two traps in measuring this

Both produce a confident wrong answer, which is worse than no answer:

- **A probe calling `ctx.mcpReq.elicitInput()` measures the protocol ERA, not
  the capability.** That is the deprecated 2025 push API; on a 2026 leg it
  fails with *"server-to-client requests are not available on protocol
  revision 2026-07-28"* regardless of what the client declared, so it reports
  the identical result for every client. Use `inputRequired(...)` — what
  `requireConfirmation` actually returns.
- **`isError: true` is not a thrown exception.** A harness checking only for a
  throw reads a refusal as success. The first run of our sweep printed
  "elicitation SUCCEEDED" three times.

## Re-running this

**Telemetry** — `meta.clientCapabilities`, `protocolVersion`,
`progressToken`, `session`, `cost` on `usage_events` (mcp-host
`docs/USAGE.md`):

```sql
SELECT json_extract(meta_json,'$.clientName')         AS client,
       json_extract(meta_json,'$.clientCapabilities') AS caps,
       COUNT(*)                                       AS n
  FROM usage_events
 WHERE kind='mcp_request'
   AND json_extract(meta_json,'$.clientName') IS NOT NULL
 GROUP BY client, caps;
```

Known gap: **`clientName` is recorded on `initialize` only**, so a
`tools/call` cannot be attributed to a client.

**The probe** — `~/git/mcp-probe`, connect `/c/probe/mcp`, run the four
prompts in its README. Most groups **self-report**: the answer is which tool
the model calls next, so it lands in `usage_events.meta.name` and needs
nobody watching a screen. Tool *arguments* are never the channel — they are
not recorded, and must not be.

## What this file implies for building

- **Annotate every tool** — silence publishes as destructive. Do it because
  the annotations are then truthful and other clients may honour them, **not**
  as a safety layer on claude.ai.
- **Write descriptions for search**, not for a reader who already found the
  tool.
- **Honour cancellation** — it is the one advanced feature claude.ai actually
  uses. `cancel` module.
- **Do not emit** `structuredContent`, `audio` or `resource_link` for
  claude.ai. Nothing consumes them and the first costs bytes.
- **Do not build on elicitation** for a hosted connector without checking
  `callerAcceptsFormElicitation(ctx)` first.
