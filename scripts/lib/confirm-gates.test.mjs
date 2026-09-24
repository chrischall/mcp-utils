// Fleet audit 2026-09-24 REF-1 (fleet-audit#945): the confirm-gate checks the
// annotation auditors apply to each served tool's inputSchema. Pure, so it is
// tested here without starting a server.
import { describe, expect, it } from 'vitest';

import { confirmGateFinding, summariseConfirmGates } from './confirm-gates.mjs';

const tool = (name, properties, annotations) => ({
  name,
  inputSchema: { type: 'object', properties },
  ...(annotations === undefined ? {} : { annotations }),
});

describe('confirmGateFinding', () => {
  it('flags a hand-rolled `confirm` boolean as an ERROR, whatever the annotations', () => {
    expect(confirmGateFinding(tool('pay', { confirm: { type: 'boolean' } }, { readOnlyHint: false })))
      .toEqual({ level: 'error', code: 'confirm-boolean' });
    // schemaConfirm's optional boolean serialises the same way.
    expect(confirmGateFinding(tool('pay', { confirm: { type: 'boolean', default: false } })))
      .toMatchObject({ code: 'confirm-boolean' });
    // A token-gated tool that ALSO kept the boolean is still an error.
    expect(confirmGateFinding(tool('pay', { confirm: { type: 'boolean' }, confirmToken: { type: 'string' } })))
      .toMatchObject({ code: 'confirm-boolean' });
  });

  it('flags a non-read tool without confirmToken as a SUSPECT (ungated write)', () => {
    expect(confirmGateFinding(tool('send', { to: { type: 'string' } }, { readOnlyHint: false, destructiveHint: true })))
      .toEqual({ level: 'suspect', code: 'ungated-write' });
    // No annotations at all is a write by the spec defaults.
    expect(confirmGateFinding(tool('send', { to: { type: 'string' } })))
      .toEqual({ level: 'suspect', code: 'ungated-write' });
    // Additive writes are suspects too — a human decides.
    expect(confirmGateFinding(tool('fav', {}, { readOnlyHint: false, destructiveHint: false })))
      .toMatchObject({ code: 'ungated-write' });
  });

  it('passes a read tool, and a write tool gated by confirmToken', () => {
    expect(confirmGateFinding(tool('list', {}, { readOnlyHint: true }))).toBeUndefined();
    expect(confirmGateFinding(tool('send', { confirmToken: { type: 'string' } }, { readOnlyHint: false }))).toBeUndefined();
  });

  it('does not mistake a non-boolean `confirm` field for the deprecated gate', () => {
    expect(confirmGateFinding(tool('x', { confirm: { type: 'string' }, confirmToken: { type: 'string' } }))).toBeUndefined();
  });

  it('tolerates a tool with no inputSchema or properties', () => {
    expect(confirmGateFinding({ name: 'r', annotations: { readOnlyHint: true } })).toBeUndefined();
    expect(confirmGateFinding({ name: 'w' })).toEqual({ level: 'suspect', code: 'ungated-write' });
  });
});

describe('summariseConfirmGates', () => {
  it('counts errors and suspects', () => {
    const tools = [
      tool('a', { confirm: { type: 'boolean' } }),
      tool('b', {}),
      tool('c', {}, { readOnlyHint: true }),
      tool('d', { confirmToken: { type: 'string' } }),
    ];
    expect(summariseConfirmGates(tools)).toEqual({
      errors: [{ name: 'a', level: 'error', code: 'confirm-boolean' }],
      suspects: [{ name: 'b', level: 'suspect', code: 'ungated-write' }],
    });
  });
});
