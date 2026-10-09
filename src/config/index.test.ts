import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  createCachedJsonArrayLoader,
  expandPath,
  loadDotenvSafely,
  parseBoolEnv,
  readEnvVar,
  readPortEnv,
  requireEnvVar,
} from './index.js';

describe('readEnvVar', () => {
  it('returns the trimmed value when set', () => {
    expect(readEnvVar('K', { env: { K: '  hello  ' } })).toBe('hello');
  });

  it('reads from process.env by default', () => {
    process.env.MCP_UTILS_TEST_VAR = 'fromProcess';
    try {
      expect(readEnvVar('MCP_UTILS_TEST_VAR')).toBe('fromProcess');
    } finally {
      delete process.env.MCP_UTILS_TEST_VAR;
    }
  });

  it('returns undefined when the key is absent', () => {
    expect(readEnvVar('MISSING', { env: {} })).toBeUndefined();
  });

  it('treats a non-string value as unset', () => {
    // Simulate an env-like object that hands back a non-string.
    const env = { K: 123 as unknown as string };
    expect(readEnvVar('K', { env })).toBeUndefined();
  });

  it('treats an empty / whitespace-only value as unset', () => {
    expect(readEnvVar('K', { env: { K: '' } })).toBeUndefined();
    expect(readEnvVar('K', { env: { K: '   ' } })).toBeUndefined();
  });

  it('treats the literal strings "undefined" and "null" as unset', () => {
    expect(readEnvVar('K', { env: { K: 'undefined' } })).toBeUndefined();
    expect(readEnvVar('K', { env: { K: 'null' } })).toBeUndefined();
    // case sensitivity: only the exact lowercase literals are sentinels
    expect(readEnvVar('K', { env: { K: 'NULL' } })).toBe('NULL');
  });

  it('treats an unsubstituted ${...} placeholder as unset (security)', () => {
    expect(readEnvVar('K', { env: { K: '${FOO}' } })).toBeUndefined();
    expect(readEnvVar('K', { env: { K: '${}' } })).toBeUndefined();
    expect(readEnvVar('K', { env: { K: '  ${BAR}  ' } })).toBeUndefined();
  });

  it('does NOT treat a value that merely contains ${...} as a placeholder', () => {
    // Only a value that is *entirely* a placeholder is suppressed; a real
    // secret that happens to embed ${ is kept verbatim.
    expect(readEnvVar('K', { env: { K: 'prefix${FOO}' } })).toBe('prefix${FOO}');
    expect(readEnvVar('K', { env: { K: '${FOO}${BAR}' } })).toBe('${FOO}${BAR}');
  });

  it('falls back to the provided default when unset', () => {
    expect(readEnvVar('K', { env: {}, default: 'd' })).toBe('d');
    expect(readEnvVar('K', { env: { K: '${X}' }, default: 'd' })).toBe('d');
  });

  it('does not apply the default when a real value is present', () => {
    expect(readEnvVar('K', { env: { K: 'real' }, default: 'd' })).toBe('real');
  });

  describe('{ trim: false } (secrets)', () => {
    it('returns the value byte-for-byte, keeping surrounding whitespace', () => {
      // A password may legitimately start or end with a space (schoolpass #691).
      expect(readEnvVar('PW', { env: { PW: ' p4ss ' }, trim: false })).toBe(' p4ss ');
      expect(readEnvVar('PW', { env: { PW: 'p4ss\t' }, trim: false })).toBe('p4ss\t');
    });

    it('still treats empty, whitespace-only, sentinels and placeholders as unset', () => {
      for (const v of ['', '   ', 'undefined', ' null ', '${PW}', ' ${PW} ']) {
        expect(readEnvVar('PW', { env: { PW: v }, trim: false })).toBeUndefined();
      }
      expect(readEnvVar('PW', { env: {}, trim: false, default: 'd' })).toBe('d');
    });

    it('defaults to trimming (existing behaviour)', () => {
      expect(readEnvVar('PW', { env: { PW: ' p4ss ' } })).toBe('p4ss');
      expect(readEnvVar('PW', { env: { PW: ' p4ss ' }, trim: true })).toBe('p4ss');
    });
  });
});

describe('requireEnvVar', () => {
  it('returns the value when set', () => {
    expect(requireEnvVar('K', { env: { K: 'v' } })).toBe('v');
  });

  it('throws when unset', () => {
    expect(() => requireEnvVar('API_KEY', { env: {} })).toThrow(/API_KEY/);
  });

  it('throws when the value is a placeholder (security)', () => {
    expect(() => requireEnvVar('API_KEY', { env: { API_KEY: '${API_KEY}' } })).toThrow(
      /API_KEY/,
    );
  });

  it('includes the hint in the error message', () => {
    expect(() =>
      requireEnvVar('API_KEY', { env: {}, hint: 'get one at example.com' }),
    ).toThrow(/get one at example\.com/);
  });

  it('passes { trim: false } through for secrets', () => {
    expect(requireEnvVar('PW', { env: { PW: ' p4ss ' }, trim: false })).toBe(' p4ss ');
    expect(requireEnvVar('PW', { env: { PW: ' p4ss ' } })).toBe('p4ss');
    expect(() => requireEnvVar('PW', { env: { PW: '  ' }, trim: false })).toThrow(/PW/);
  });

  it('does not leak any value into the error message', () => {
    let message = '';
    try {
      requireEnvVar('API_KEY', { env: { API_KEY: '${SECRET}' } });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('SECRET');
  });
});

describe('parseBoolEnv', () => {
  it('parses truthy tokens (case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'On']) {
      expect(parseBoolEnv('K', { env: { K: v } })).toBe(true);
    }
  });

  it('parses falsy tokens (case-insensitive)', () => {
    for (const v of ['0', 'false', 'FALSE', 'no', 'NO', 'off', 'Off']) {
      expect(parseBoolEnv('K', { env: { K: v } })).toBe(false);
    }
  });

  it('returns the default (false) when unset', () => {
    expect(parseBoolEnv('K', { env: {} })).toBe(false);
  });

  it('honours an explicit default when unset', () => {
    expect(parseBoolEnv('K', { env: {}, default: true })).toBe(true);
  });

  it('treats placeholders / sentinels as unset and uses the default', () => {
    expect(parseBoolEnv('K', { env: { K: '${X}' }, default: true })).toBe(true);
    expect(parseBoolEnv('K', { env: { K: 'null' }, default: true })).toBe(true);
  });

  it('returns the default for an unrecognised value', () => {
    expect(parseBoolEnv('K', { env: { K: 'maybe' }, default: true })).toBe(true);
    expect(parseBoolEnv('K', { env: { K: 'maybe' }, default: false })).toBe(false);
  });
});

describe('expandPath', () => {
  it('expands a leading ~/ to the home directory', () => {
    expect(expandPath('~/foo/bar')).toBe(join(homedir(), 'foo/bar'));
  });

  it('expands a bare ~ to the home directory', () => {
    expect(expandPath('~')).toBe(homedir());
  });

  it('does not expand ~ embedded mid-path', () => {
    const out = expandPath('./a~b');
    expect(out).toBe(resolve('./a~b'));
  });

  it('returns an absolute path unchanged', () => {
    expect(expandPath('/etc/hosts')).toBe('/etc/hosts');
  });

  it('resolves a relative path against the cwd', () => {
    const out = expandPath('foo/bar');
    expect(isAbsolute(out)).toBe(true);
    expect(out).toBe(resolve('foo/bar'));
  });

  it('does not treat ~otheruser as a home expansion', () => {
    // We only expand `~` and `~/...`, never `~user` (no /etc/passwd lookup).
    // The literal `~otheruser` survives as a path segment (resolved vs cwd).
    const out = expandPath('~otheruser/x');
    expect(out).toBe(resolve('~otheruser/x'));
    expect(out).toContain('~otheruser');
  });
});

describe('loadDotenvSafely', () => {
  const realEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...realEnv };
  });

  it('returns false and does not throw when dotenv is unavailable', async () => {
    // No path given and dotenv import may fail in this bundle context; the
    // contract is simply: never throw, return a boolean.
    const result = await loadDotenvSafely({ path: '/nonexistent/.env' });
    expect(typeof result).toBe('boolean');
  });

  it('never throws even with a bogus path', async () => {
    await expect(loadDotenvSafely({ path: '\0bad' })).resolves.toBeTypeOf('boolean');
  });
});

describe('readPortEnv', () => {
  it('returns a valid port', () => {
    expect(readPortEnv('P', 8080, { env: { P: '37149' } })).toBe(37149);
    expect(readPortEnv('P', 8080, { env: { P: '1' } })).toBe(1);
    expect(readPortEnv('P', 8080, { env: { P: '65535' } })).toBe(65535);
  });

  it('falls back when unset / blank', () => {
    expect(readPortEnv('P', 8080, { env: {} })).toBe(8080);
    expect(readPortEnv('P', 8080, { env: { P: '   ' } })).toBe(8080);
  });

  it('falls back on an unsubstituted ${...} placeholder', () => {
    expect(readPortEnv('P', 8080, { env: { P: '${REDFIN_WS_PORT}' } })).toBe(8080);
  });

  it('falls back on a non-numeric value', () => {
    expect(readPortEnv('P', 8080, { env: { P: 'abc' } })).toBe(8080);
    expect(readPortEnv('P', 8080, { env: { P: '12abc' } })).toBe(8080);
    expect(readPortEnv('P', 8080, { env: { P: '1.5' } })).toBe(8080);
  });

  it('falls back on an out-of-range value', () => {
    expect(readPortEnv('P', 8080, { env: { P: '0' } })).toBe(8080);
    expect(readPortEnv('P', 8080, { env: { P: '65536' } })).toBe(8080);
    expect(readPortEnv('P', 8080, { env: { P: '99999' } })).toBe(8080);
  });
});

describe('createCachedJsonArrayLoader', () => {
  const DEFAULTS = ['a', 'b'];

  it('returns the parsed array when the file is present and valid', () => {
    const readFile = vi.fn(() => JSON.stringify(['x', 'y', 'z']));
    const load = createCachedJsonArrayLoader({
      envVar: 'COMMUNITIES_FILE',
      defaults: DEFAULTS,
      env: { COMMUNITIES_FILE: '/communities.json' },
      readFile,
    });
    expect(load()).toEqual(['x', 'y', 'z']);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('caches the parsed result — second call does not re-read', () => {
    const readFile = vi.fn(() => JSON.stringify(['x']));
    const load = createCachedJsonArrayLoader({
      envVar: 'COMMUNITIES_FILE',
      defaults: DEFAULTS,
      env: { COMMUNITIES_FILE: '/communities.json' },
      readFile,
    });
    expect(load()).toEqual(['x']);
    expect(load()).toEqual(['x']);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('returns defaults when the env var is unset', () => {
    const readFile = vi.fn(() => '[]');
    const load = createCachedJsonArrayLoader({
      envVar: 'COMMUNITIES_FILE',
      defaults: DEFAULTS,
      env: {},
      readFile,
    });
    expect(load()).toBe(DEFAULTS);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('returns defaults and negative-caches a missing / unreadable file', () => {
    const readFile = vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = createCachedJsonArrayLoader({
      envVar: 'COMMUNITIES_FILE',
      defaults: DEFAULTS,
      env: { COMMUNITIES_FILE: '/missing.json' },
      readFile,
    });
    expect(load()).toBe(DEFAULTS);
    expect(load()).toBe(DEFAULTS);
    expect(readFile).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('returns defaults and negative-caches invalid JSON', () => {
    const readFile = vi.fn(() => 'not json {');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = createCachedJsonArrayLoader({
      envVar: 'COMMUNITIES_FILE',
      defaults: DEFAULTS,
      env: { COMMUNITIES_FILE: '/bad.json' },
      readFile,
    });
    expect(load()).toBe(DEFAULTS);
    expect(load()).toBe(DEFAULTS);
    expect(readFile).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('returns defaults and negative-caches a non-string-array', () => {
    const readFile = vi.fn(() => JSON.stringify([1, 2, 3]));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = createCachedJsonArrayLoader({
      envVar: 'COMMUNITIES_FILE',
      defaults: DEFAULTS,
      env: { COMMUNITIES_FILE: '/numbers.json' },
      readFile,
    });
    expect(load()).toBe(DEFAULTS);
    expect(load()).toBe(DEFAULTS);
    expect(readFile).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('also negative-caches a non-array (object) payload', () => {
    const readFile = vi.fn(() => JSON.stringify({ not: 'an array' }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = createCachedJsonArrayLoader({
      envVar: 'COMMUNITIES_FILE',
      defaults: DEFAULTS,
      env: { COMMUNITIES_FILE: '/obj.json' },
      readFile,
    });
    expect(load()).toBe(DEFAULTS);
    expect(readFile).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('re-reads when the env path changes', () => {
    const env = { COMMUNITIES_FILE: '/one.json' };
    const readFile = vi.fn((p: string) => JSON.stringify([p]));
    const load = createCachedJsonArrayLoader({
      envVar: 'COMMUNITIES_FILE',
      defaults: DEFAULTS,
      env,
      readFile,
    });
    expect(load()).toEqual(['/one.json']);
    env.COMMUNITIES_FILE = '/two.json';
    expect(load()).toEqual(['/two.json']);
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
