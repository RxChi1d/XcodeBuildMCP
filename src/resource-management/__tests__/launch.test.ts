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
import { launchSimulatorAppWithLogging } from '../../utils/simulator-steps.ts';
import { sessionStore } from '../../utils/session-store.ts';
import { handler } from '../../mcp/tools/simulator/launch_app_sim.ts';

vi.mock('../../utils/simulator-steps.ts', () => ({
  launchSimulatorAppWithLogging: vi.fn(() => {
    throw new Error('Detached launch is forbidden in this fixture');
  }),
}));
const bundleId = 'com.example.LeaseFixture';
let directory: string;
let manager: SimulatorResourceManager;
let lease: Lease;
const moduleId = 'mcp/tools/simulator/launch_app_sim';
const context = (): ToolHandlerContext => ({ emit: () => {}, attach: () => {} });
const credentials = () => ({
  bundleId,
  simulatorId: lease.simulatorId,
  operationRequestId: lease.requestId,
  operationToken: lease.token,
  operationSessionId: lease.sessionId,
});
const launch = wrapManagedTool(moduleId, (args, ctx) => {
  if (!ctx) throw new Error('Missing fixture context');
  return handler(args, ctx);
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-launch-'));
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
  sessionStore.clear();
  expect(launchSimulatorAppWithLogging).not.toHaveBeenCalled();

  vi.unstubAllEnvs();

  await rm(directory, { recursive: true, force: true });
});

function commands(
  options: {
    failure?: 'pre-exit' | 'pre-reject' | 'pre-open' | 'exit' | 'reject' | 'open' | 'unknown-exit';
    output?: string;
    onLaunch?: () => Promise<void>;
  } = {},
) {
  const calls: string[][] = [];
  const stream = new PassThrough();
  const root = join(directory, 'checkout');
  const mock = createMockExecutor({});
  __setTestCommandExecutorOverride(async (...args) => {
    const response = await mock(...args);
    const cmd = args[0];
    if (cmd[0] === 'git')
      return {
        ...response,
        output: `${cmd.at(-1) === '--show-toplevel' ? root : join(root, '.git')}\n`,
      };
    calls.push(cmd);
    expect(args[2]).toBe(false);
    expect(args[4]).toBeUndefined();
    if (cmd[2] === 'get_app_container') {
      expect(cmd).toEqual([
        'xcrun',
        'simctl',
        'get_app_container',
        lease.simulatorId,
        bundleId,
        'app',
      ]);
      if (options.failure === 'pre-reject') throw new Error('executor lost');
      if (options.failure === 'pre-open') response.process.stdout = stream;
      return { ...response, success: options.failure !== 'pre-exit', output: '/fixture/App.app' };
    }
    expect(cmd.slice(0, 6)).toEqual([
      'xcrun',
      'simctl',
      'launch',
      '--terminate-running-process',
      lease.simulatorId,
      bundleId,
    ]);
    expect(cmd).not.toContain('--console-pty');
    if (args[3]?.env) expect(args[3].env).toEqual({ SIMCTL_CHILD_TEST_FLAG: 'fixture value' });
    await options.onLaunch?.();
    if (options.failure === 'reject') throw new Error('executor lost');
    if (options.failure === 'open') response.process.stdout = stream;
    if (options.failure === 'unknown-exit') Object.assign(response.process, { exitCode: null });
    return {
      ...response,
      success: options.failure !== 'exit',
      output: options.output ?? `${bundleId}: 1234\n`,
    };
  });
  return { calls, stream };
}

it.each([undefined, [], ['--fixture', 'two words', '$(literal)']])(
  'launches with literal arguments %j and no background helper',
  async (launchArgs) => {
    const { calls } = commands();
    const ctx = context();
    await launch(
      { ...credentials(), launchArgs, env: [{ key: 'TEST_FLAG', value: 'fixture value' }] },
      ctx,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].slice(6)).toEqual(launchArgs ?? []);
    expect(ctx.structuredOutput?.result).toMatchObject({
      didError: false,
      artifacts: { simulatorId: lease.simulatorId, bundleId, processId: 1234 },
    });
    expect(ctx.structuredOutput?.result).not.toHaveProperty('artifacts.runtimeLogPath');
    expect(ctx.nextSteps).toEqual([]);
    expect((await manager.getStatus(lease.requestId)).state).toBe('active');
    expect((await manager.end(lease)).state).toBe('released');
  },
);

it('requires explicit public bundle/lease/target arguments and blocks foreign credentials', async () => {
  const { calls } = commands();
  const schema = managedToolSchema(moduleId, {});
  expect(schema.bundleId.safeParse(undefined).success).toBe(false);
  expect(schema.bundleId.safeParse('').success).toBe(false);
  expect(schema.simulatorId.safeParse(undefined).success).toBe(false);
  for (const args of [
    { simulatorId: lease.simulatorId, bundleId },
    { ...credentials(), operationToken: randomUUID() },
    { ...credentials(), simulatorId: randomUUID() },
  ]) {
    await expect(launch(args, context())).rejects.toThrow();
  }
  for (const invalid of ['', '--console']) {
    const ctx = context();
    await launch({ ...credentials(), bundleId: invalid }, ctx);
    expect(ctx.structuredOutput?.result.didError).toBe(true);
  }
  expect(calls).toEqual([]);
});

it('returns a safe domain failure when installed-app preflight fails', async () => {
  const { calls } = commands({ failure: 'pre-exit' });
  const ctx = context();
  await launch(credentials(), ctx);
  expect(calls).toHaveLength(1);
  expect(ctx.structuredOutput?.result.didError).toBe(true);
  expect((await manager.end(lease)).state).toBe('released');
});

it.each(['pre-reject', 'pre-open', 'exit', 'reject', 'open', 'unknown-exit'] as const)(
  'retains activity and blocks handoff on %s',
  async (failure) => {
    const { calls, stream } = commands({ failure });
    try {
      await expect(launch(credentials(), context())).rejects.toThrow(
        'completion could not be confirmed',
      );
      expect(calls).toHaveLength(failure.startsWith('pre-') ? 1 : 2);
      await expect(manager.end(lease)).rejects.toThrow(
        'Operation is blocked; end/cancel cannot recover it',
      );
      expect((await manager.getStatus(lease.requestId)).activities).toHaveLength(1);
    } finally {
      stream.destroy();
    }
  },
);

it.each([
  '',
  'foreign.bundle: 1234',
  `${bundleId}: 0`,
  `${bundleId}: 9007199254740992`,
  `${bundleId}: 12garbage`,
])('blocks ambiguous successful launch output %j', async (output) => {
  commands({ output });
  await expect(launch(credentials(), context())).rejects.toThrow(
    'completion could not be confirmed',
  );
  await expect(manager.end(lease)).rejects.toThrow(
    'Operation is blocked; end/cancel cannot recover it',
  );
});

it.each(['success', 'failure'])('drains closing launch before handoff: %s', async (outcome) => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  commands({
    failure: outcome === 'failure' ? 'exit' : undefined,
    onLaunch: async () => {
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
  const call = launch(credentials(), context()).then(
    () => 'success',
    () => 'failure',
  );
  await started;
  expect((await manager.end(lease)).state).toBe('closing');
  expect((await manager.poll(waiting)).state).toBe('waiting');
  release();
  expect(await call).toBe(outcome);
  expect((await manager.getStatus(lease.requestId)).state).toBe(
    outcome === 'success' ? 'released' : 'blocked',
  );
  expect((await manager.poll(waiting)).state).toBe(outcome === 'success' ? 'active' : 'waiting');
});

it('serializes launches sharing one token', async () => {
  let active = 0;
  let maximum = 0;
  commands({
    onLaunch: async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
    },
  });
  await Promise.all([launch(credentials(), context()), launch(credentials(), context())]);
  expect(maximum).toBe(1);
  expect((await manager.getStatus(lease.requestId)).activities).toHaveLength(0);
});
