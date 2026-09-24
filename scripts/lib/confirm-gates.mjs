/**
 * Confirm-gate checks on a SERVED tool's inputSchema, shared by
 * audit-annotations.mjs (one server) and audit-fleet-annotations.mjs (every
 * server beside this repo).
 *
 * Why on the wire: the September 2026 migration to confirmToken was driven by
 * `git grep schemaConfirm`, and missed schoolpass-mcp, signupgenius-mcp and
 * setlist-mcp because they declared `confirm: z.boolean()` by hand (fleet
 * audit 2026-09-24 REF-1). What a server publishes cannot hide that way.
 *
 * - ERROR `confirm-boolean`: a top-level boolean `confirm` input — the
 *   deprecated gate a model can satisfy on its first call without a preview.
 *   Always wrong in the fleet, whatever else the tool declares.
 * - SUSPECT `ungated-write`: a tool not annotated `readOnlyHint: true` whose
 *   input has no `confirmToken`. Many additive writes are deliberately
 *   ungated (a favourite, a local cache sync), so a human reads each one;
 *   it is a list, not a verdict.
 */

/** @typedef {{ level: 'error' | 'suspect', code: 'confirm-boolean' | 'ungated-write' }} ConfirmGateFinding */

/**
 * @param {{ name: string, inputSchema?: { properties?: Record<string, any> }, annotations?: { readOnlyHint?: boolean } }} tool
 * @returns {ConfirmGateFinding | undefined}
 */
export function confirmGateFinding(tool) {
  const props = tool.inputSchema?.properties ?? {};
  const confirm = Object.hasOwn(props, 'confirm') ? props.confirm : undefined;
  const isBoolean = (s) => s?.type === 'boolean' || (Array.isArray(s?.type) && s.type.includes('boolean'));
  if (confirm && isBoolean(confirm)) return { level: 'error', code: 'confirm-boolean' };
  if (tool.annotations?.readOnlyHint === true) return undefined;
  if (!Object.hasOwn(props, 'confirmToken')) return { level: 'suspect', code: 'ungated-write' };
  return undefined;
}

/** Every finding across a tool list, split by level, each tagged with its tool name. */
export function summariseConfirmGates(tools) {
  const errors = [];
  const suspects = [];
  for (const t of tools) {
    const f = confirmGateFinding(t);
    if (!f) continue;
    (f.level === 'error' ? errors : suspects).push({ name: t.name, ...f });
  }
  return { errors, suspects };
}
