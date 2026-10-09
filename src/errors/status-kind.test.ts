import { describe, it, expect } from 'vitest';
import {
  McpToolError,
  SessionNotAuthenticatedError,
  BotWallError,
  RateLimitError,
  UnreachableError,
  ModeMismatchError,
  UpstreamFormatError,
  MCP_TOOL_ERROR_KINDS,
  errorKindOf,
  errorStatusOf,
  wrapToolError,
  type McpToolErrorKind,
} from './index.js';
import * as root from '../index.js';

// Fleet audit 2026-09, cluster 8: seven repos classified failures by regex
// over message text (`/401|403|forbidden/`, `/\b429\b|\b503\b/`, `/auth|sign/`
// matching "assign") because an McpToolError carried no status. These pin the
// structured fields that replace those regexes.

describe('McpToolError status / kind', () => {
  it('carries an optional HTTP status and kind', () => {
    const err = new McpToolError('nope', { hint: 'h', status: 403, kind: 'credential_rejected' });
    expect(err.status).toBe(403);
    expect(err.kind).toBe('credential_rejected');
    expect(err.hint).toBe('h');
  });

  it('leaves both undefined when not given (existing constructions are unchanged)', () => {
    const plain = new McpToolError('plain');
    expect(plain.status).toBeUndefined();
    expect(plain.kind).toBeUndefined();
    const hinted = new McpToolError('x', { hint: 'h' });
    expect(hinted.status).toBeUndefined();
    expect(hinted.kind).toBeUndefined();
    expect(JSON.stringify(Object.entries(hinted).filter(([, v]) => v !== undefined))).not.toContain('status');
  });

  it('keeps a cause alongside the new fields', () => {
    const cause = new Error('root');
    const err = new McpToolError('wrapped', { status: 500, kind: 'http', cause });
    expect(err.cause).toBe(cause);
  });

  it('exports the kind vocabulary from the root barrel', () => {
    expect(root.MCP_TOOL_ERROR_KINDS).toBe(MCP_TOOL_ERROR_KINDS);
    expect([...MCP_TOOL_ERROR_KINDS].sort()).toEqual(
      [
        'credential_rejected',
        'edge_blocked',
        'http',
        'no_credential',
        'session_expired',
        'timeout',
        'too_large',
        'transport',
        'unknown',
        'verification_pending',
      ].sort(),
    );
    const k: McpToolErrorKind = 'timeout';
    expect(MCP_TOOL_ERROR_KINDS.has(k)).toBe(true);
  });
});

describe('library throwers set status / kind', () => {
  it('SessionNotAuthenticatedError is session_expired', () => {
    const err = new SessionNotAuthenticatedError('Compass', 'compass.com');
    expect(err.kind).toBe('session_expired');
    expect(err.status).toBeUndefined();
  });

  it('RateLimitError is HTTP 429', () => {
    const err = new RateLimitError('Svc', 10);
    expect(err.status).toBe(429);
    expect(err.kind).toBe('http');
    expect(err.retryAfterSeconds).toBe(10);
  });

  it('UnreachableError with a status is http, without one is transport', () => {
    const http = new UnreachableError('Svc', 503);
    expect(http.status).toBe(503);
    expect(http.kind).toBe('http');
    const transport = new UnreachableError('Svc');
    expect(transport.status).toBeUndefined();
    expect(transport.kind).toBe('transport');
  });

  it('UpstreamFormatError keeps its status and declares no kind', () => {
    const err = new UpstreamFormatError({ received: 'non-json', status: 200 });
    expect(err.status).toBe(200);
    expect(err.kind).toBeUndefined();
    const noStatus = new UpstreamFormatError({ received: 'empty' });
    expect(noStatus.status).toBeUndefined();
  });

  it('BotWallError and ModeMismatchError declare nothing (no honest status/kind)', () => {
    expect(new BotWallError('/x').kind).toBeUndefined();
    expect(new BotWallError('/x').status).toBeUndefined();
    expect(new ModeMismatchError('a', 'b', 'f').kind).toBeUndefined();
  });
});

describe('errorStatusOf / errorKindOf', () => {
  it('read the fields off an McpToolError', () => {
    const err = new McpToolError('x', { status: 404, kind: 'http' });
    expect(errorStatusOf(err)).toBe(404);
    expect(errorKindOf(err)).toBe('http');
  });

  it('read a status off any error shape (status or statusCode)', () => {
    expect(errorStatusOf(Object.assign(new Error('x'), { status: 401 }))).toBe(401);
    expect(errorStatusOf(Object.assign(new Error('x'), { statusCode: 502 }))).toBe(502);
    expect(errorStatusOf({ status: '401' })).toBeUndefined();
    expect(errorStatusOf('401')).toBeUndefined();
    expect(errorStatusOf(null)).toBeUndefined();
    expect(errorStatusOf(undefined)).toBeUndefined();
  });

  it('follow a short cause chain (a hint-wrapper keeps the status it wrapped)', () => {
    const inner = Object.assign(new Error('Unauthorized'), { status: 401 });
    const outer = new McpToolError('Sign in again.', { hint: 'run login', cause: inner });
    expect(errorStatusOf(outer)).toBe(401);
    const deep = new Error('a', { cause: new Error('b', { cause: new McpToolError('c', { kind: 'timeout' }) }) });
    expect(errorKindOf(deep)).toBe('timeout');
  });

  it('let the outermost declaration win', () => {
    const inner = new McpToolError('in', { status: 500, kind: 'http' });
    const outer = new McpToolError('out', { status: 401, kind: 'credential_rejected', cause: inner });
    expect(errorStatusOf(outer)).toBe(401);
    expect(errorKindOf(outer)).toBe('credential_rejected');
  });

  it('ignore a kind outside the vocabulary (another library\'s `kind` field)', () => {
    expect(errorKindOf({ kind: 'bridge_down' })).toBeUndefined();
    expect(errorKindOf({ kind: 'ok' })).toBeUndefined();
    expect(errorKindOf({ kind: 42 })).toBeUndefined();
    // …and keep looking down the chain past it.
    expect(errorKindOf({ kind: 'weird', cause: { kind: 'transport' } })).toBe('transport');
  });

  it('stop on a cyclic chain', () => {
    const a: { cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(errorStatusOf(a)).toBeUndefined();
    expect(errorKindOf(a)).toBeUndefined();
  });

  it('do not read past the depth bound', () => {
    let e: unknown = { status: 418, kind: 'http' };
    for (let i = 0; i < 4; i++) e = { cause: e };
    expect(errorStatusOf(e)).toBeUndefined();
    expect(errorKindOf(e)).toBeUndefined();
  });
});

describe('wrapToolError carries status / kind', () => {
  it('copies them off a wrapped McpToolError', () => {
    const wrapped = wrapToolError('t', new McpToolError('x', { hint: 'h', status: 403, kind: 'credential_rejected' }));
    expect(wrapped.status).toBe(403);
    expect(wrapped.kind).toBe('credential_rejected');
    expect(wrapped.hint).toBe('h');
  });

  it('copies the status off a plain status-carrying error (an ApiError)', () => {
    const wrapped = wrapToolError('t', Object.assign(new Error('Server error'), { status: 503 }));
    expect(wrapped.status).toBe(503);
    expect(wrapped.kind).toBeUndefined();
  });

  it('declares nothing for an error that declared nothing', () => {
    const wrapped = wrapToolError('t', new Error('boom'));
    expect(wrapped.status).toBeUndefined();
    expect(wrapped.kind).toBeUndefined();
  });
});
