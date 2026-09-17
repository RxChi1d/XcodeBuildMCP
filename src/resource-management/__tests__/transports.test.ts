import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createMockExecutor } from '../../test-utils/mock-executors.ts';
import { DaemonClient } from '../../cli/daemon-client.ts';
import { SimulatorResourceManager } from '../manager.ts';
import { resolveManagedWorktree } from '../worktree.ts';
import { resourceEnvironment } from '../environment.ts';
import type { ResourceOperationDomainResult } from '../../types/domain-results.ts';

const fixture = fileURLToPath(new URL('./fixtures/transport-worker.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
const clients: Client[] = [];
const children: { child: ChildProcess; exited: Promise<unknown> }[] = [];
let directory: string | undefined;
let socketDirectory: string | undefined;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const { child, exited } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
  if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('hands off a bound Simulator between live MCP sessions, direct CLI, and the daemon', async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-transports-'));
  const root = join(directory, 'checkout');
  await mkdir(join(root, '.git'), { recursive: true });
  vi.stubEnv('XCODEBUILDMCP_OPERATION_STATE_ROOT', join(directory, 'state'));
  vi.stubEnv('XCODEBUILDMCP_OPERATION_CAPACITY', '1');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const executor = createMockExecutor({});
  const tree = await resolveManagedWorktree(root, async (...args) => ({
    ...(await executor(...args)),
    output: `${args[0].at(-1) === '--show-toplevel' ? root : join(root, '.git')}\n`,
  }));
  const manager = await SimulatorResourceManager.open(resourceEnvironment()!);
  const simulatorId = randomUUID();
  await manager.bind(tree, { deviceType: 'fixture', runtime: 'fixture' }, simulatorId);

  async function mcp(): Promise<Client> {
    const client = new Client({ name: 'lease-test', version: '1' });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', loader, fixture, 'mcp'],
      cwd: root,
      env,
      stderr: 'pipe',
    });
    let errors = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(errors, { cause: error });
    }
    return client;
  }
  async function call(
    client: Client,
    args: Record<string, unknown>,
  ): Promise<ResourceOperationDomainResult> {
    const response = await client.callTool({ name: 'resource_operation', arguments: args });
    if (response.isError) throw new Error(JSON.stringify(response.content));
    return (response.structuredContent as { data: ResourceOperationDomainResult }).data;
  }
  const a = await mcp();
  const b = await mcp();
  const requestA = { requestId: randomUUID(), sessionId: randomUUID() };
  const requestB = { requestId: randomUUID(), sessionId: randomUUID() };
  const first = await call(a, { action: 'begin', ...requestA });
  expect(first).toMatchObject({ state: 'active', simulatorId });
  expect(await call(a, { action: 'begin', ...requestA })).toMatchObject({ token: first.token });
  expect(await call(b, { action: 'begin', ...requestB })).toMatchObject({ state: 'waiting' });
  await call(a, { action: 'end', ...requestA, token: first.token });
  const second = await call(b, { action: 'begin', ...requestB });
  expect(second).toMatchObject({ state: 'active', simulatorId });
  // A remains connected and can inspect its completed operation after B takes over.
  expect(await call(a, { action: 'status', requestId: requestA.requestId })).toMatchObject({
    state: 'released',
  });

  function spawn(mode: string, args: string[] = []): ChildProcess {
    const child = fork(fixture, [mode, ...args], {
      cwd: root,
      env,
      execArgv: ['--import', loader],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push({ child, exited: once(child, 'exit') });
    return child;
  }
  const cli = spawn('cli', [
    'resource-management',
    'operation',
    '--action',
    'end',
    '--request-id',
    requestB.requestId,
    '--session-id',
    requestB.sessionId,
    '--token',
    second.token!,
    '--output',
    'json',
  ]);
  let stdout = '';
  let stderr = '';
  cli.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  cli.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = await once(cli, 'exit');
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout).data).toMatchObject({ state: 'released' });

  const daemon = spawn('daemon');
  let daemonError = '';
  daemon.stderr?.on('data', (chunk: Buffer) => {
    daemonError += chunk.toString();
  });
  const [ready] = (await Promise.race([
    once(daemon, 'message'),
    once(daemon, 'exit').then(() => {
      throw new Error(`Daemon fixture exited: ${daemonError}`);
    }),
  ])) as [{ ready: boolean; socketPath: string }];
  socketDirectory = dirname(ready.socketPath);
  // Namespace checks are independent of the caller cwd; supply this fixture's target explicitly.
  vi.stubEnv('XCODEBUILDMCP_OPERATION_STATE_ROOT', undefined);
  vi.stubEnv('XCODEBUILDMCP_OPERATION_CAPACITY', undefined);
  const client = new DaemonClient({ socketPath: ready.socketPath });
  expect((await client.status()).resourceNamespace).toBe(resourceEnvironment(env)!.namespace);
  const requestC = { requestId: randomUUID(), sessionId: randomUUID() };
  const routed = spawn('cli-daemon', [
    'resource-management',
    'operation',
    '--action',
    'begin',
    '--request-id',
    requestC.requestId,
    '--session-id',
    requestC.sessionId,
    '--output',
    'json',
  ]);
  let routedOutput = '';
  let routedError = '';
  routed.stdout?.on('data', (chunk: Buffer) => {
    routedOutput += chunk.toString();
  });
  routed.stderr?.on('data', (chunk: Buffer) => {
    routedError += chunk.toString();
  });
  expect((await once(routed, 'exit'))[0], routedError).toBe(0);
  const result = JSON.parse(routedOutput).data as ResourceOperationDomainResult;
  expect(result).toMatchObject({ state: 'active', simulatorId });
  await expect(
    client.invokeTool('resource_operation', { action: 'status', requestId: requestC.requestId }),
  ).rejects.toThrow('namespace mismatch');
  expect(await call(a, { action: 'status', requestId: requestC.requestId })).not.toHaveProperty(
    'token',
  );
  await call(a, { action: 'end', ...requestC, token: result.token });
}, 20_000);
