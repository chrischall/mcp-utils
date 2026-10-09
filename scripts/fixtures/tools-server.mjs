/**
 * A stdio MCP server whose tools come from FIXTURE_TOOLS (JSON:
 * [{ name, annotations?, confirm? }]), for ../audit-annotations.test.mjs to
 * run the real CLI against. `confirm: true` gives the tool a boolean
 * `confirm` input — the confirm-gate ERROR. Imports the SDK directly (not
 * mcp-utils' dist) so the CLI test needs no build.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const specs = JSON.parse(process.env.FIXTURE_TOOLS ?? '[]');

serveStdio(() => {
  const server = new McpServer({ name: 'tools-fixture', version: '0.0.0' });
  for (const s of specs) {
    server.registerTool(
      s.name,
      {
        description: s.name,
        inputSchema: z.object(s.confirm ? { confirm: z.boolean() } : {}),
        ...(s.annotations ? { annotations: s.annotations } : {}),
      },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
  }
  return server;
}, { legacy: 'serve' });
