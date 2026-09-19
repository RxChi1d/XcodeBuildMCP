import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMockExecutor } from '../../test-utils/mock-executors.ts';
import {
  __setTestCommandExecutorOverride,
  __clearTestExecutorOverrides,
} from '../../utils/command.ts';
import type { ToolHandlerContext } from '../../rendering/types.ts';
import { resourceEnvironment } from '../environment.ts';
import { managedToolSchema, wrapManagedTool } from '../tool-gate.ts';
import { SimulatorResourceManager, type Lease } from '../manager.ts';
import { resolveManagedWorktree } from '../worktree.ts';
import { handler } from '../../mcp/tools/simulator/boot_sim.ts';

let directory: string;
let manager: SimulatorResourceManager;
let lease: Lease;
const moduleId = 'mcp/tools/simulator/boot_sim';
const context = (): ToolHandlerContext => ({ emit: () => {}, attach: () => {} });
const credentials = () => ({
  simulatorId: lease.simulatorId,
  operationRequestId: lease.requestId,
  operationToken: lease.token,
  operationSessionId: lease.sessionId,
});
const boot = wrapManagedTool(moduleId, (args, ctx) => {
  if (!ctx) throw new Error('Missing fixture context');
  return handler(args, ctx);
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-boot-'));
  const root = join(directory, 'checkout');
  await mkdir(join(root, '.git'), { recursive: true });
  vi.stubEnv('XCODEBUILDMCP_OPERATION_STATE_ROOT', join(directory, 'state'));
  vi.stubEnv('XCODEBUILDMCP_OPERATION_CAPACITY', '1');
  const executor = createMockExecutor({});
  __setTestCommandExecutorOverride(async (...args) => {
    if (args[0][0] !== 'git') throw new Error('Unexpected external command');
    return {
      ...(await executor(...args)),
      output: `${args[0].at(-1) === '--show-toplevel' ? root : join(root, '.git')}\n`,
    };
  });
  const worktree = await resolveManagedWorktree(root, async (...args) => {
    return {
      ...(await executor(...args)),
      output: `${args[0].at(-1) === '--show-toplevel' ? root : join(root, '.git')}\n`,
    };
  });
  manager = await SimulatorResourceManager.open(resourceEnvironment()!);
  await manager.bind(worktree, { deviceType: 'fixture', runtime: 'fixture' }, randomUUID());
  lease = await manager.requestLease({
    requestId: randomUUID(),
    owner: { sessionId: randomUUID() },
    worktree,
  });
});

afterEach(async () => {
  __clearTestExecutorOverrides();

  vi.unstubAllEnvs();

  await rm(directory, { recursive: true, force: true });
});

function commands(
  options: {
    before?: string;
    available?: boolean;
    missing?: boolean;
    postState?: string;
    failure?:
      | 'exit'
      | 'reject'
      | 'open-stream'
      | 'unknown-exit'
      | 'post-json'
      | 'pre-json'
      | 'pre-exit'
      | 'pre-reject'
      | 'pre-open';
    onBoot?: () => Promise<void>;
  } = {},
) {
  const calls: string[][] = [];
  const stream = new PassThrough();
  let booted = false;
  const mock = createMockExecutor({});
  const root = join(directory, 'checkout');
  __setTestCommandExecutorOverride(async (...args) => {
    const cmd = args[0];
    const response = await mock(...args);
    if (cmd[0] === 'git')
      return {
        ...response,
        output: `${cmd.at(-1) === '--show-toplevel' ? root : join(root, '.git')}\n`,
      };
    calls.push(cmd);
    expect(args[2]).toBe(false);
    if (cmd[2] === 'bootstatus') {
      expect(cmd).toEqual(['xcrun', 'simctl', 'bootstatus', lease.simulatorId, '-b']);
      await options.onBoot?.();
      if (options.failure === 'reject') throw new Error('lost executor');
      if (options.failure === 'exit') return createMockExecutor({ success: false })(...args);
      if (options.failure === 'open-stream') response.process.stdout = stream;
      if (options.failure === 'unknown-exit') Object.assign(response.process, { exitCode: null });
      booted = true;
      return response;
    }
    expect(cmd).toEqual(['xcrun', 'simctl', 'list', 'devices', '--json']);
    if (options.failure === 'pre-reject' && !booted) {
      throw new Error('catalog preflight executor rejected');
    }
    if (options.failure === 'pre-exit' && !booted) {
      return createMockExecutor({
        success: false,
        exitCode: 1,
        error: 'catalog preflight failed',
      })(...args);
    }
    if (options.failure === 'pre-open' && !booted) response.process.stdout = stream;
    if ((options.failure === 'post-json' && booted) || options.failure === 'pre-json')
      return { ...response, output: 'invalid' };
    return {
      ...response,
      output: JSON.stringify({
        devices: {
          runtime: options.missing
            ? []
            : [
                {
                  udid: lease.simulatorId.toUpperCase(),
                  isAvailable: options.available ?? true,
                  state: booted ? (options.postState ?? 'Booted') : (options.before ?? 'Shutdown'),
                },
              ],
        },
      }),
    };
  });
  return { calls, stream };
}

it.each(['Shutdown', 'Booting', 'Booted'])(
  'waits for readiness from %s under the existing lease',
  async (before) => {
    const { calls } = commands({ before });
    const ctx = context();
    await boot(credentials(), ctx);
    expect(calls).toHaveLength(3);
    expect(ctx.structuredOutput?.result).toMatchObject({
      didError: false,
      action: { type: 'boot' },
      artifacts: { simulatorId: lease.simulatorId },
    });
    expect(ctx.nextSteps).toEqual([]);
    expect((await manager.getStatus(lease.requestId)).state).toBe('active');
    expect((await manager.end(lease)).state).toBe('released');
  },
);

it('rejects missing credentials, wrong token and foreign UUID before device commands', async () => {
  const { calls } = commands();
  expect(managedToolSchema(moduleId, {})).toHaveProperty('operationToken');
  for (const args of [
    { simulatorId: lease.simulatorId },
    { ...credentials(), operationToken: randomUUID() },
    { ...credentials(), simulatorId: randomUUID() },
  ]) {
    await expect(boot(args, context())).rejects.toThrow();
  }
  expect(calls).toEqual([]);
});

it.each([{ missing: true }, { available: false }])(
  'returns a safe preflight domain failure: %j',
  async (options) => {
    const { calls } = commands(options);
    const ctx = context();
    await boot(credentials(), ctx);
    expect(ctx.structuredOutput?.result.didError).toBe(true);
    expect(calls).toHaveLength(1);
    expect((await manager.end(lease)).state).toBe('released');
  },
);

it.each([
  'exit',
  'reject',
  'open-stream',
  'unknown-exit',
  'post-json',
  'pre-reject',
  'pre-open',
] as const)('blocks handoff on %s', async (failure) => {
  const { calls, stream } = commands({ failure });
  try {
    await expect(boot(credentials(), context())).rejects.toThrow(
      'completion could not be confirmed',
    );
    await expect(manager.end(lease)).rejects.toThrow(
      'Operation is blocked; end/cancel cannot recover it',
    );
    expect((await manager.getStatus(lease.requestId)).activities).toHaveLength(1);
    expect(calls).toHaveLength(
      failure === 'pre-open' || failure === 'pre-reject' ? 1 : failure === 'post-json' ? 3 : 2,
    );
  } finally {
    stream.destroy();
  }
});

it('releases a malformed read-only preflight but blocks unverified post-boot state', async () => {
  commands({ failure: 'pre-json' });
  await expect(boot(credentials(), context())).rejects.toThrow();
  expect((await manager.getStatus(lease.requestId)).activities).toHaveLength(0);
  commands({ postState: 'Booting' });
  await expect(boot(credentials(), context())).rejects.toThrow();
  await expect(manager.end(lease)).rejects.toThrow(
    'Operation is blocked; end/cancel cannot recover it',
  );
});

it('releases a confirmed nonzero read-only preflight failure', async () => {
  const { calls } = commands({ failure: 'pre-exit' });

  await expect(boot(credentials(), context())).rejects.toThrow('Simulator command failed');
  expect(calls).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
  expect((await manager.getStatus(lease.requestId)).state).toBe('active');
  expect((await manager.getStatus(lease.requestId)).activities).toHaveLength(0);
  expect((await manager.end(lease)).state).toBe('released');
});

it('keeps a closing operation held until readiness finishes before granting a new session', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  commands({
    onBoot: async () => {
      entered();
      await finish;
    },
  });
  const binding = await manager.getBinding((await manager.getStatus(lease.requestId)).generation);
  if (!binding) throw new Error('Missing fixture binding');
  const waiting = await manager.requestLease({
    requestId: randomUUID(),
    owner: { sessionId: randomUUID() },
    worktree: binding.worktree,
  });
  const run = boot(credentials(), context());
  await started;
  expect((await manager.end(lease)).state).toBe('closing');
  expect((await manager.poll(waiting)).state).toBe('waiting');
  release();
  await run;
  expect((await manager.getStatus(lease.requestId)).state).toBe('released');
  expect((await manager.poll(waiting)).state).toBe('active');
});
