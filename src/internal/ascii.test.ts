import { describe, expect, it } from 'vitest';

import { asciiLower } from './ascii.js';

describe('asciiLower', () => {
  it('lowercases ASCII letters only and preserves length', () => {
    const input = 'İSTANBUL <SCRIPT Type="X">';
    const out = asciiLower(input);
    expect(out).toBe('İstanbul <script type="x">');
    expect(out.length).toBe(input.length);
  });
});
