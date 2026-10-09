/**
 * Type-level guard for `confirmationFromEnv`'s 3.0 contract: `account` and
 * `args` are REQUIRED keys (fleet-audit#979, #986, #1066, #1072, #1086, #1089,
 * #1098 were all a token minted without one of them).
 *
 * `npm run typecheck` excludes `*.test.ts`, so a `// @ts-expect-error` here
 * would never be checked by it. Instead this file type-checks ITSELF: it runs
 * the repo's `tsc --noEmit` over a throwaway tsconfig that extends the real one
 * and lists only this file, and asserts a clean exit. An `@ts-expect-error`
 * whose line compiles cleanly is itself error TS2578, so a regression that
 * makes either key optional again fails this test.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { confirmationFromEnv, type ConfirmationFromEnvOptions } from './confirm-env.js';

const subject = () => ({ target: 'm1', payload: { id: 'm1' }, preview: { id: 'm1' } });

/** Never called: the cases only have to compile (or fail to, where marked). */
export function typeCases(): void {
  // OK: both keys present; `account: undefined` written down on a single-account server.
  confirmationFromEnv({ action: 'a', message: 'm', tool: 't', subject, account: undefined, args: { id: 'm1' } });
  confirmationFromEnv({ action: 'a', message: 'm', tool: 't', subject, account: 'alice', args: { id: 'm1' } });

  // @ts-expect-error -- `account` is a required key.
  confirmationFromEnv({ action: 'a', message: 'm', tool: 't', subject, args: { id: 'm1' } });

  // @ts-expect-error -- `args` is a required key.
  confirmationFromEnv({ action: 'a', message: 'm', tool: 't', subject, account: undefined });

  // @ts-expect-error -- `args` may not be undefined: that would bind nothing.
  confirmationFromEnv({ action: 'a', message: 'm', tool: 't', subject, account: undefined, args: undefined });

  // @ts-expect-error -- `args` may not be null either.
  confirmationFromEnv({ action: 'a', message: 'm', tool: 't', subject, account: undefined, args: null });

  // @ts-expect-error -- `account` must be a string (or explicitly undefined).
  confirmationFromEnv({ action: 'a', message: 'm', tool: 't', subject, account: 42, args: {} });

  const opts: Pick<ConfirmationFromEnvOptions, 'account' | 'args'> = { account: undefined, args: {} };
  void opts;
}

const TSC = fileURLToPath(new URL('../../node_modules/.bin/tsc', import.meta.url));
const BASE_TSCONFIG = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
// `types: ["node"]` resolves against the PROJECT's directory, which is a temp dir here.
const TYPE_ROOTS = fileURLToPath(new URL('../../node_modules/@types', import.meta.url));

describe('ConfirmationFromEnvOptions (type level)', () => {
  it('requires account and args: this file compiles with every @ts-expect-error consumed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpu-confirm-types-'));
    try {
      const project = join(dir, 'tsconfig.json');
      writeFileSync(project, JSON.stringify({
        extends: BASE_TSCONFIG,
        compilerOptions: { noEmit: true, composite: false, declaration: false, declarationMap: false, incremental: false, typeRoots: [TYPE_ROOTS],
        },
        files: [fileURLToPath(import.meta.url)],
        include: [],
      }));
      const run = await promisify(execFile)(TSC, ['-p', project, '--pretty', 'false'])
        .then(() => ({ code: 0, out: '' }))
        .catch((e: { code?: number; stdout?: string; stderr?: string }) => ({
          code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
        }));
      expect(run.out).toBe('');
      expect(run.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
