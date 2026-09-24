/**
 * The confirm-token fallback: a human-approval step for a client that cannot
 * show an MCP elicitation prompt.
 *
 * {@link requireConfirmation} asks through elicitation and REFUSES a caller that
 * declares none. Measured: claude.ai declares none, so every confirmation-gated
 * tool is inert there. This module is the opt-in way through, hoisted out of
 * gogcli-mcp, where it was first built for its Gmail/Chat/Drive/Classroom/
 * Calendar dispatches:
 *
 * 1. Phase 1: the tool is called without a token. Nothing happens. It returns
 *    `status: "confirmation-required"`, the full preview and a `confirmToken`,
 *    with an instruction to show the preview to the user and call again only
 *    after they approve in chat.
 * 2. Phase 2: the same call plus `confirmToken`. The tool RE-READS what it would
 *    act on, and proceeds only if that still matches what the token was issued
 *    for.
 *
 * A token is an HMAC-SHA256 over the tool, account, target, the target's
 * revision (a draft's messageId, an event's etag) and a SHA-256 of the
 * canonical payload, with an expiry. It is single-use through a spent-token
 * store. A mismatch returns `DRAFT_CHANGED` with a fresh preview and token;
 * otherwise `TOKEN_EXPIRED`, `TOKEN_REUSED` or `TOKEN_INVALID`. None of them acts.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. With elicitation the host asks the user and
 * the model never holds the approval. Here the approval IS a tool argument, so
 * the check that a human approved is the model following the instruction. The
 * token guarantees what happens is exactly what was previewed, once, for that
 * tool, account and target, and that a preview call came first (unlike a bare
 * `confirm: true`). It cannot prove a human said yes, which is why callers
 * should make it opt-in.
 *
 * Deliberately env-free: the caller supplies the key, the TTL and whether the
 * fallback is on, as {@link ConfirmationBinding} does.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { callerAcceptsFormElicitation } from '../caller/index.js';
import { textResult } from '../response/index.js';
import { canonicalJson } from './canonical.js';
import { requireConfirmation, type RequireConfirmationOptions } from './confirmation.js';

/** Why a phase-2 token was refused. `DRAFT_CHANGED` covers any target, not only drafts. */
export type ConfirmTokenError = 'DRAFT_CHANGED' | 'TOKEN_EXPIRED' | 'TOKEN_REUSED' | 'TOKEN_INVALID';

/** Which part of the binding moved, for a `DRAFT_CHANGED`. */
export type ConfirmTokenChange = 'revision-changed' | 'payload-changed';

/** What a token is bound to. Every field must match on phase 2. */
export interface ConfirmTokenBinding {
  /** The tool that issued it; a token never crosses tools. */
  tool: string;
  /** The account / principal the action runs as. Absent binds as absent. */
  account?: string;
  /** The draftId / messageId / fileId / query the action targets. */
  target: string;
  /** A version of the target that rotates on edit. Absent binds as absent. */
  revision?: string;
  /** {@link hashConfirmPayload} of the canonical payload. */
  payloadHash: string;
}

/** The verdict on a phase-2 token. Only `ok` spends it. */
export type ConfirmTokenVerdict =
  | { ok: true }
  | { ok: false; error: 'DRAFT_CHANGED'; reason: ConfirmTokenChange }
  | { ok: false; error: Exclude<ConfirmTokenError, 'DRAFT_CHANGED'> };

/**
 * Tokens already used, keyed by nonce until they would have expired anyway.
 * In memory: with a key shared across processes, a restart or a second instance
 * would accept a spent token again until it expires.
 */
export interface SpentTokenStore {
  has(nonce: string): boolean;
  add(nonce: string, expiresAtMs: number): void;
  /** Drop entries that expired before `now`. */
  prune(now: number): void;
  clear(): void;
  readonly size: number;
}

/** A fresh in-memory {@link SpentTokenStore}. */
export function createSpentTokenStore(): SpentTokenStore {
  const spent = new Map<string, number>();
  return {
    has: (nonce) => spent.has(nonce),
    add: (nonce, exp) => { spent.set(nonce, exp); },
    prune: (now) => { for (const [nonce, exp] of spent) if (exp < now) spent.delete(nonce); },
    clear: () => spent.clear(),
    get size() { return spent.size; },
  };
}

// The default store: process-wide, so one approval acts once however many
// tools in this process verify tokens. Pass `spent` to scope or reset it.
const PROCESS_SPENT = createSpentTokenStore();

const PREFIX = 'mcpu.token.v1.';
const DEFAULT_TTL_SECONDS = 600;

type Claims = { t: string; a?: string; g: string; r?: string; h: string; exp: number; n: string };

function tokenKey(key: string | Uint8Array): Buffer {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key);
  if (bytes.length < 32) throw new RangeError('confirm token: key must be at least 32 bytes.');
  return bytes;
}

function ttlOf(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined) return DEFAULT_TTL_SECONDS;
  if (!(Number.isFinite(ttlSeconds) && ttlSeconds > 0)) {
    throw new RangeError('confirm token: ttlSeconds must be a finite number greater than 0.');
  }
  return ttlSeconds;
}

function sign(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(`${PREFIX}${body}`).digest();
}

/**
 * SHA-256 (base64url) of a payload's canonical form: keys sorted, undefined
 * dropped, bytes/Dates/Maps/Sets typed. The same canonical form
 * `requireConfirmation`'s `binding` commits to.
 */
export function hashConfirmPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('base64url');
}

/** Options shared by {@link issueConfirmToken} and {@link verifyConfirmToken}. */
export interface ConfirmTokenClock {
  /** Epoch ms; defaults to `Date.now()`. */
  now?: number;
}

/** Mint a phase-1 token for `binding`. */
export function issueConfirmToken(
  key: string | Uint8Array,
  binding: ConfirmTokenBinding,
  options: ConfirmTokenClock & { ttlSeconds?: number } = {},
): { token: string; expiresAt: string } {
  const k = tokenKey(key);
  const now = options.now ?? Date.now();
  const exp = now + ttlOf(options.ttlSeconds) * 1000;
  const claims: Claims = {
    t: binding.tool,
    ...(binding.account === undefined ? {} : { a: binding.account }),
    g: binding.target,
    ...(binding.revision === undefined ? {} : { r: binding.revision }),
    h: binding.payloadHash,
    exp,
    n: randomBytes(16).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return { token: `${PREFIX}${body}.${sign(k, body).toString('base64url')}`, expiresAt: new Date(exp).toISOString() };
}

function parseClaims(body: string): Claims | undefined {
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Claims;
    return claims && typeof claims === 'object' ? claims : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check a phase-2 token against the binding recomputed from a FRESH read. Only
 * an `ok` verdict spends it; a `DRAFT_CHANGED` leaves it unspent, since the
 * approval it carries is still true of the content it names.
 */
export function verifyConfirmToken(
  key: string | Uint8Array,
  token: string,
  binding: ConfirmTokenBinding,
  options: ConfirmTokenClock & { spent?: SpentTokenStore } = {},
): ConfirmTokenVerdict {
  const k = tokenKey(key);
  const now = options.now ?? Date.now();
  const spent = options.spent ?? PROCESS_SPENT;
  spent.prune(now);

  if (!token.startsWith(PREFIX)) return { ok: false, error: 'TOKEN_INVALID' };
  const rest = token.slice(PREFIX.length);
  const dot = rest.indexOf('.');
  const body = dot < 0 ? '' : rest.slice(0, dot);
  const mac = Buffer.from(dot < 0 ? '' : rest.slice(dot + 1), 'base64url');
  const expected = sign(k, body);
  if (!body || mac.length !== expected.length || !timingSafeEqual(mac, expected)) return { ok: false, error: 'TOKEN_INVALID' };
  const claims = parseClaims(body);
  if (!claims) return { ok: false, error: 'TOKEN_INVALID' };

  if (claims.t !== binding.tool || claims.a !== binding.account || claims.g !== binding.target) {
    return { ok: false, error: 'TOKEN_INVALID' };
  }
  if (spent.has(claims.n)) return { ok: false, error: 'TOKEN_REUSED' };
  if (now > claims.exp) return { ok: false, error: 'TOKEN_EXPIRED' };
  if (claims.r !== binding.revision) return { ok: false, error: 'DRAFT_CHANGED', reason: 'revision-changed' };
  if (claims.h !== binding.payloadHash) return { ok: false, error: 'DRAFT_CHANGED', reason: 'payload-changed' };

  spent.add(claims.n, claims.exp);
  return { ok: true };
}

/** The phase-1 instruction a tool returns unless it supplies its own. */
export const CONFIRM_TOKEN_INSTRUCTION =
  'Show this preview to the user verbatim and proceed only after they explicitly approve in chat. '
  + 'Then call again with confirmToken.';

/** The `confirmToken` input a gated tool adds to its schema. */
export const confirmTokenParam = z.string().optional().describe(
  'ONLY for the two-step confirmation fallback (a client without MCP elicitation). The confirmToken from this same '
  + 'tool\'s phase-1 "confirmation-required" response, passed back ONLY after the user has seen that preview and '
  + 'explicitly approved it in chat — never on the first call, never invented, never reused. Call again with the '
  + 'same arguments. Ignored when the client supports elicitation.',
);

/** What a token binds, recomputed from a fresh read on every call. */
export interface ConfirmSubject {
  /** The draftId / messageId / fileId / query the action targets. */
  target: string;
  /** A version of the target that rotates on edit. */
  revision?: string;
  /** Canonical payload; its hash is bound into the token. */
  payload: unknown;
  /** The complete preview shown to the user. */
  preview: Record<string, unknown>;
}

/** Enables the token fallback. See {@link requireConfirmationWithFallback}. */
export interface ConfirmTokenFallback {
  /** HMAC key, at least 32 bytes; the same for every process that may see phase 2. */
  key: string | Uint8Array;
  /** The tool name the token is bound to. */
  tool: string;
  /** The account the action runs as. */
  account?: string;
  /** The phase-2 token, or undefined on phase 1. */
  confirmToken?: string;
  /**
   * Build the subject from a FRESH read. Called only when the fallback runs,
   * so an extra read here never touches the elicitation path. May return an
   * error result (a failed read), which is passed back unchanged.
   */
  subject: () => ConfirmSubject | CallToolResult | Promise<ConfirmSubject | CallToolResult>;
  /** Token lifetime; default 600 s. */
  ttlSeconds?: number;
  /** Phase 1's instruction; defaults to {@link CONFIRM_TOKEN_INSTRUCTION}. */
  instruction?: string;
  /** Spent-token store; defaults to a process-wide one. */
  spent?: SpentTokenStore;
}

/** {@link RequireConfirmationOptions} plus the optional token fallback. */
export interface RequireConfirmationWithFallbackOptions extends RequireConfirmationOptions {
  /**
   * Pass to replace the refusal a caller that cannot be prompted would get
   * with the two-phase token flow. Omit to keep the refusal. Whether it is on
   * is the caller's decision (typically an opt-in env var).
   */
  tokenFallback?: ConfirmTokenFallback;
}

const TOKEN_ERROR_NOTE: Record<Exclude<ConfirmTokenError, 'DRAFT_CHANGED'>, string> = {
  TOKEN_EXPIRED: 'Nothing was sent or changed: the confirmToken expired. Call again WITHOUT confirmToken for a fresh '
    + 'preview, and ask the user to approve it again.',
  TOKEN_REUSED: 'Nothing was sent or changed by this call: this confirmToken was already used, and one approval acts '
    + 'once. If doing it again is really intended, call again WITHOUT confirmToken and get a new approval.',
  TOKEN_INVALID: 'Nothing was sent or changed: this confirmToken was not issued by this server for this tool, account '
    + 'and target (or the server has restarted since). Call again WITHOUT confirmToken for a fresh preview and approval.',
};

const CHANGED_NOTE: Record<ConfirmTokenChange, string> = {
  'revision-changed': 'Nothing was sent or changed: the target was edited since the user approved it (its version '
    + 'rotated), so what would happen is not what they saw.',
  'payload-changed': 'Nothing was sent or changed: what would happen no longer matches what the user approved.',
};

function isToolResult(value: ConfirmSubject | CallToolResult): value is CallToolResult {
  return Array.isArray((value as CallToolResult).content);
}

function rejection(data: Record<string, unknown>): CallToolResult {
  return { ...textResult({ status: 'confirmation-rejected', confirmed: false, dispatched: false, ...data }), isError: true };
}

async function tokenConfirmation(action: string, fb: ConfirmTokenFallback): Promise<CallToolResult | undefined> {
  const subject = await fb.subject();
  if (isToolResult(subject)) return subject;
  const binding: ConfirmTokenBinding = {
    tool: fb.tool,
    ...(fb.account === undefined ? {} : { account: fb.account }),
    target: subject.target,
    ...(subject.revision === undefined ? {} : { revision: subject.revision }),
    payloadHash: hashConfirmPayload(subject.payload),
  };
  const phaseOne = () => {
    const { token, expiresAt } = issueConfirmToken(fb.key, binding, { ttlSeconds: fb.ttlSeconds });
    return {
      action,
      preview: subject.preview,
      confirmToken: token,
      expiresAt,
      ttlSeconds: ttlOf(fb.ttlSeconds),
      instruction: fb.instruction ?? CONFIRM_TOKEN_INSTRUCTION,
    };
  };
  if (!fb.confirmToken) {
    return textResult({ status: 'confirmation-required', confirmed: false, dispatched: false, ...phaseOne() });
  }
  const verdict = verifyConfirmToken(fb.key, fb.confirmToken, binding, { spent: fb.spent });
  if (verdict.ok) return undefined;
  if (verdict.error === 'DRAFT_CHANGED') {
    return rejection({
      error: 'DRAFT_CHANGED',
      reason: verdict.reason,
      note: `${CHANGED_NOTE[verdict.reason]} The current preview and a fresh confirmToken are below.`,
      ...phaseOne(),
    });
  }
  return rejection({ error: verdict.error, action, note: TOKEN_ERROR_NOTE[verdict.error] });
}

/**
 * {@link requireConfirmation}, with an opt-in second rail for a caller that
 * cannot be prompted.
 *
 * Elicitation stays primary and is untouched: a caller that can be asked is
 * asked, and `tokenFallback.subject` is never called. Only when the caller
 * declares it cannot be prompted AND `tokenFallback` is given does the
 * two-phase token flow run instead of the refusal. `undefined` means proceed;
 * anything else is the result to return unchanged.
 */
export async function requireConfirmationWithFallback(
  ctx: ServerContext,
  options: RequireConfirmationWithFallbackOptions,
): Promise<InputRequiredResult | CallToolResult | undefined> {
  const { tokenFallback, ...confirmation } = options;
  if (tokenFallback && callerAcceptsFormElicitation(ctx) === false) {
    return tokenConfirmation(options.action, tokenFallback);
  }
  return requireConfirmation(ctx, confirmation);
}
