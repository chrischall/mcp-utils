/**
 * A real MCP server, booted exactly the way the fleet boots one, for
 * `stdio.test.ts` to drive over a real stdio pipe.
 *
 * It is deliberately `.mjs` and deliberately imports the BUILT package
 * (`dist/`) rather than the TypeScript source:
 *
 *  - `.mjs` keeps it out of `tsconfig.json`'s `include` (`src/**\/*.ts`), so it
 *    is never compiled and never published — `package.json#files` ships `dist`
 *    only.
 *  - importing `dist/` means the child process exercises the artifact a fleet
 *    repo actually installs. The regression this fixture exists for
 *    (`server/discover` → "Method not found") is invisible to an in-process
 *    mock transport, so a test that stubbed the SDK would have shipped the bug
 *    twice.
 *
 * `stdio.test.ts` runs `tsc -b` before spawning this, so `dist/` is current.
 *
 * Shape notes, because they are the claim under test:
 *  - the result of `runMcp` is AWAITED AND DISCARDED, which is what every one of the 60
 *    fleet consumers do — this file is byte-for-byte a valid fleet entrypoint,
 *    so it stops compiling the day the call site breaks.
 *  - `deps` is built OUTSIDE the call, so the test can prove one `deps` is
 *    shared by every instance the factory produces.
 */
import { z } from 'zod';
import { runMcp } from '../../dist/index.js';

/**
 * Stands in for the API client / session a fleet MCP builds at boot: expensive,
 * credential-bearing, and constructed exactly once no matter how many server
 * instances serve the connection.
 */
const deps = { greeting: 'hello', builtAt: process.hrtime.bigint().toString() };

await runMcp({
  name: 'fixture-mcp',
  version: '9.9.9',
  banner: 'fixture-mcp banner',
  deps,
  // Default `'serve'` unless a test asks for the other branch. `legacy` is a
  // new public option and `'reject'` is the half that drops pre-2026 hosts, so
  // it needs driving over a real pipe rather than trusting the pass-through.
  ...(process.env.FIXTURE_LEGACY ? { legacy: process.env.FIXTURE_LEGACY } : {}),
  tools: [
    (server, d) => {
      // One line per constructed instance: the test counts these to see how
      // many times the factory ran.
      console.error('fixture:registrars-ran');
      // A credential-shaped failure on demand, thrown from the FACTORY so it
      // travels the entry's real error path — caught, handed to `reportError`,
      // and printed by whatever `onerror` is in force. The fixture passes
      // none, so that is the package default, `redactSecrets` and all. A timer
      // throw would be an uncaught exception and never reach the sink.
      if (process.env.FIXTURE_THROW_SECRET) {
        throw new Error(`boot failed: token=${process.env.FIXTURE_THROW_SECRET}`);
      }
      server.registerTool(
        'echo',
        { description: 'Echo a message back', inputSchema: z.object({ msg: z.string() }) },
        async ({ msg }) => ({ content: [{ type: 'text', text: `${d.greeting} ${msg} ${d.builtAt}` }] }),
      );
    },
  ],
});

// Printed only once `runMcp` has RETURNED, which is the first moment
// `withGracefulShutdown` has installed its SIGINT/SIGTERM handlers. The banner
// cannot stand in for this: `runMcp` prints it BEFORE calling `serveStdio`,
// and installs the handlers after — so a test that signals on the banner is
// still racing the boot, just at a different point.
console.error('fixture:handlers-installed');
