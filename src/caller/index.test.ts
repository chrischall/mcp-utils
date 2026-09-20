import { describe, expect, it } from 'vitest';
import {
  callerAcceptsFormElicitation,
  callerCapabilities,
  currentCallerCapabilities,
  withCallerCapabilities,
} from './index.js';

function ctxWithEnvelope(capabilities: unknown): unknown {
  return {
    mcpReq: {
      envelope: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': capabilities,
      },
    },
  };
}

describe('withCallerCapabilities / currentCallerCapabilities', () => {
  it('carries the declaration across an await', async () => {
    const seen = await withCallerCapabilities({ elicitation: { form: {} } }, async () => {
      await Promise.resolve();
      return currentCallerCapabilities();
    });

    expect(seen).toEqual({ elicitation: { form: {} } });
  });

  it('answers undefined outside any wrapped call', () => {
    expect(currentCallerCapabilities()).toBeUndefined();
  });

  it('does not enter a context for an unresolved declaration', () => {
    // An empty store and no store are the same answer, so the wrapper skips
    // the context rather than storing `undefined` and making them differ.
    expect(withCallerCapabilities(undefined, () => currentCallerCapabilities())).toBeUndefined();
  });
});

describe('callerCapabilities', () => {
  it('prefers the request envelope over the ambient connection-scoped value', () => {
    // The case this ordering exists for: a 2026-07-28 relay forwards the real
    // caller's declaration per request, so two callers on one connection
    // differ and the ambient value would answer about the wrong one.
    const seen = withCallerCapabilities({ elicitation: { form: {} } }, () =>
      callerCapabilities(ctxWithEnvelope({ extensions: {} })));

    expect(seen).toEqual({ extensions: {} });
  });

  it('falls back to the ambient value when the era carries no envelope', () => {
    const seen = withCallerCapabilities({ elicitation: { form: {} } }, () =>
      callerCapabilities({ mcpReq: {} }));

    expect(seen).toEqual({ elicitation: { form: {} } });
  });

  it.each([
    ['a context that is not an object', 'nope'],
    ['a context with no mcpReq', {}],
    ['an envelope that is not an object', { mcpReq: { envelope: 'nope' } }],
    ['an envelope whose capabilities are not an object', ctxWithEnvelope('nope')],
  ])('answers undefined for %s with nothing ambient', (_label, ctx) => {
    expect(callerCapabilities(ctx)).toBeUndefined();
  });
});

describe('callerAcceptsFormElicitation', () => {
  // Every row was driven through a real @modelcontextprotocol/server 2.0.0
  // client before it was written down: `{}` and `{form:{}}` deliver an
  // input_required result, `{url:{}}` and an absent `elicitation` answer
  // -32021.
  it.each([
    ['form is offered', { elicitation: { form: {} } }, true],
    ['no modes are enumerated', { elicitation: {} }, true],
    ['both modes are offered', { elicitation: { form: {}, url: {} } }, true],
    ['only url is offered', { elicitation: { url: {} } }, false],
    ['elicitation is absent', { extensions: {} }, false],
    ['nothing at all is declared', {}, false],
    ['elicitation is declared as a non-object', { elicitation: true }, false],
  ])('is %s -> %s', (_label, capabilities, expected) => {
    expect(callerAcceptsFormElicitation(ctxWithEnvelope(capabilities))).toBe(expected);
  });

  it('answers undefined — never false — when neither source knows', () => {
    // Load-bearing: a caller reading this as "no" would refuse every caller it
    // cannot see, which includes any handler registered outside
    // `surfaceToolHints`.
    expect(callerAcceptsFormElicitation({ mcpReq: {} })).toBeUndefined();
  });
});
