import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import yargs from 'yargs';
import { handler, schema } from '../../../mcp/tools/resource-management/resource_operation.ts';
import { createMockExecutor } from '../../../test-utils/mock-executors.ts';
import { __setTestCommandExecutorOverride } from '../../../utils/command.ts';
import { getConfig } from '../../../utils/config-store.ts';
import { createToolCatalog } from '../../../runtime/tool-catalog.ts';
import { registerToolCommands } from '../../../cli/register-tool-commands.ts';
import { startDaemonServer } from '../../../daemon/daemon-server.ts';
import { getSocketPath, ensureSocketDir } from '../../../daemon/socket-path.ts';
import { createRenderSession } from '../../../rendering/render.ts';
import { toStructuredEnvelope } from '../../../utils/structured-output-envelope.ts';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import { configureRuntimeWorkspaceKey } from '../../../utils/runtime-instance.ts';
import { workspaceKeyForRoot } from '../../../utils/workspace-identity.ts';

// Every command is injected. This worker never starts Git or any device executable.
const root = process.cwd();
configureRuntimeWorkspaceKey(workspaceKeyForRoot(root));
const executor = createMockExecutor({});
__setTestCommandExecutorOverride(async (...args) => {
  if (args[0][0] !== 'git') throw new Error('Unexpected fixture command');
  return {
    ...(await executor(...args)),
    output: `${args[0].at(-1) === '--show-toplevel' ? root : join(root, '.git')}\n`,
  };
});
const mode = process.argv[2];
const catalog = createToolCatalog([
  {
    id: 'resource_operation',
    mcpName: 'resource_operation',
    cliName: 'operation',
    workflow: 'resource-management',
    cliSchema: schema,
    mcpSchema: schema,
    stateful: mode === 'cli-daemon',
    handler,
  },
]);

if (mode === 'mcp') {
  const server = new McpServer({ name: 'resource-transport-fixture', version: '1' });
  server.registerTool('resource_operation', { inputSchema: schema }, async (args) => {
    const render = createRenderSession('text');
    const ctx: ToolHandlerContext = { emit: render.emit, attach: render.attach };
    await handler(args, ctx);
    const output = ctx.structuredOutput;
    if (!output) throw new Error('Missing result');
    render.setStructuredOutput?.(output);
    return {
      content: [{ type: 'text', text: render.finalize() }],
      structuredContent: {
        ...toStructuredEnvelope(output.result, output.schema, output.schemaVersion),
      },
    };
  });
  await server.connect(new StdioServerTransport());
} else if (mode === 'daemon') {
  const socketPath = getSocketPath();
  ensureSocketDir(socketPath);
  const server = startDaemonServer({
    socketPath,
    startedAt: new Date().toISOString(),
    enabledWorkflows: ['resource-management'],
    catalog,
    workspaceRoot: root,
    workspaceKey: 'fixture',
    xcodeIdeWorkflowEnabled: false,
    requestShutdown: () => server.close(),
  });
  server.listen(socketPath, () => process.send?.({ ready: true, socketPath }));
  server.once('error', (error) => {
    throw error;
  });
  process.on('disconnect', () => server.close(() => process.exit(0)));
} else if (mode === 'cli' || mode === 'cli-daemon') {
  const app = yargs()
    .exitProcess(false)
    .strict()
    .option('socket', { type: 'string', default: getSocketPath() });
  registerToolCommands(app, catalog, { workspaceRoot: root, runtimeConfig: getConfig() });
  await app.parseAsync(process.argv.slice(3));
} else {
  throw new Error('Unknown transport fixture mode');
}
