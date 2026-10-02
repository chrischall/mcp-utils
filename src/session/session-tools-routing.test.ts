/**
 * registerSessionTools descriptions (fleet-audit#1092).
 *
 * The shared trio described `set_active_session` as switching "which registered
 * session subsequent tool calls route through" and mentioned a per-call
 * `session_id` override. Only onehome routes; zillow/redfin/homes/compass use
 * the registry as a label (the fetchproxy bridge always uses the bound tab), so
 * the text told the model something false. homes-mcp had to wrap the server in a
 * Proxy to swap the descriptions.
 */
import { describe, expect, it } from 'vitest';

import { createTestHarness } from '../test/index.js';
import { createSessionRegistry, registerSessionTools, type RegisterSessionToolsOptions } from './index.js';

async function descriptions(opts: RegisterSessionToolsOptions): Promise<Record<string, string>> {
  const reg = createSessionRegistry();
  const h = await createTestHarness((server) => registerSessionTools(server, reg, opts));
  const out: Record<string, string> = {};
  for (const t of await h.listTools()) out[t.name] = t.description ?? '';
  await h.close();
  return out;
}

describe('registerSessionTools routing (fleet-audit#1092)', () => {
  it("default ('routed') wording is unchanged for the consumer that routes (onehome)", async () => {
    const d = await descriptions({ prefix: 'onehome', serviceLabel: 'OneHome' });
    expect(d.onehome_set_active_session).toContain('subsequent tool calls route through');
    expect(d.onehome_set_active_session).toContain('explicit `session_id` parameter override');
    expect(d.onehome_register_session).toContain('to use when routing per-tool calls');
  });

  it("'label-only' makes no routing claim anywhere in the trio", async () => {
    const d = await descriptions({ prefix: 'homes', serviceLabel: 'Homes.com', routing: 'label-only' });
    for (const text of Object.values(d)) {
      expect(text).not.toMatch(/route|routing/i);
      expect(text).not.toContain('override');
      expect(text).toContain('label only');
      expect(text).toContain('Homes.com');
    }
    expect(Object.keys(d).sort()).toEqual(['homes_get_session_context', 'homes_register_session', 'homes_set_active_session']);
  });

  it("'label-only' appends a service-specific note when given", async () => {
    const note = 'Every homes tool call goes through whichever browser tab the extension is signed into.';
    const d = await descriptions({ prefix: 'homes', routing: 'label-only', labelOnlyNote: note });
    for (const text of Object.values(d)) expect(text.endsWith(note)).toBe(true);
  });

  it('per-tool descriptions override the generated text', async () => {
    const d = await descriptions({
      prefix: 'zillow',
      routing: 'label-only',
      descriptions: { setActive: 'Custom set-active text.' },
    });
    expect(d.zillow_set_active_session).toBe('Custom set-active text.');
    expect(d.zillow_register_session).toContain('label only');
  });
});
