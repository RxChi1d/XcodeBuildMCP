import { randomUUID } from 'node:crypto';
import { renderCliTextTranscript } from '../../utils/renderers/cli-text-renderer.ts';
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
import type { RuntimeSnapshotV1 } from '../../types/ui-snapshot.ts';
import { resourceEnvironment } from '../environment.ts';
import { managedToolSchema, wrapManagedTool } from '../tool-gate.ts';
import { SimulatorResourceManager, type Lease } from '../manager.ts';
import { resolveManagedWorktree } from '../worktree.ts';
import { handler as snapshotHandler } from '../../mcp/tools/ui-automation/snapshot_ui.ts';
import { handler as tapHandler } from '../../mcp/tools/ui-automation/tap.ts';
import { handler as typeHandler } from '../../mcp/tools/ui-automation/type_text.ts';
import { handler as launchHandler } from '../../mcp/tools/simulator/launch_app_sim.ts';
import { defaultAxeHelpers } from '../../mcp/tools/ui-automation/shared/axe-command.ts';
import {
  __resetRuntimeSnapshotStoreForTests,
  withSimulatorUiAutomationTransaction,
} from '../../mcp/tools/ui-automation/shared/snapshot-ui-state.ts';

let directory: string;
let manager: SimulatorResourceManager;
let lease: Lease;
const credentials = () => ({
  simulatorId: lease.simulatorId,
  operationRequestId: lease.requestId,
  operationToken: lease.token,
  operationSessionId: lease.sessionId,
});
const handlers = {
  snapshot_ui: snapshotHandler,
  tap: tapHandler,
  type_text: typeHandler,
  launch_app_sim: launchHandler,
};
async function call(
  name: keyof typeof handlers,
  params: Record<string, unknown> = {},
): Promise<ToolHandlerContext> {
  const ctx: ToolHandlerContext = { emit: () => {}, attach: () => {} };
  const moduleId = `mcp/tools/${name === 'launch_app_sim' ? 'simulator' : 'ui-automation'}/${name}`;
  await wrapManagedTool(moduleId, (args, context) => {
    if (!context) throw new Error('Missing fixture context');
    return handlers[name](args, context);
  })({ ...credentials(), ...params }, ctx);
  return ctx;
}
function capture(ctx: ToolHandlerContext): RuntimeSnapshotV1 {
  const result = ctx.structuredOutput?.result;
  if (
    !result ||
    !('capture' in result) ||
    !result.capture ||
    !('type' in result.capture) ||
    result.capture.type !== 'runtime-snapshot'
  )
    throw new Error('Expected full snapshot');
  return result.capture;
}
beforeEach(async () => {
  __resetRuntimeSnapshotStoreForTests();
  vi.spyOn(defaultAxeHelpers, 'getAxePath').mockReturnValue('/fixture/axe');
  vi.spyOn(defaultAxeHelpers, 'getBundledAxeEnvironment').mockReturnValue({});
  directory = await mkdtemp(join(tmpdir(), 'resource-ui-'));
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
  vi.restoreAllMocks();
  __resetRuntimeSnapshotStoreForTests();

  vi.unstubAllEnvs();

  await rm(directory, { recursive: true, force: true });
});

function commands(
  options: {
    failure?: 'open' | 'reject' | 'exit';
    failCommand?: string;
    onCommand?: (command: string[]) => Promise<void>;
  } = {},
) {
  const calls: string[][] = [];
  const stream = new PassThrough();
  const root = join(directory, 'checkout');
  const mock = createMockExecutor({});
  __setTestCommandExecutorOverride(async (...args) => {
    const result = await mock(...args);
    const cmd = args[0];
    if (cmd[0] === 'git')
      return {
        ...result,
        output: `${cmd.at(-1) === '--show-toplevel' ? root : join(root, '.git')}\n`,
      };
    calls.push(cmd);
    expect(args[2]).toBe(false);
    await options.onCommand?.(cmd);
    if (cmd[0] === 'xcrun')
      return {
        ...result,
        output: cmd[2] === 'launch' ? 'com.example.App: 1234' : '/fixture/App.app',
      };
    expect(cmd[0]).toBe('/fixture/axe');
    expect(cmd.at(-2)).toBe('--udid');
    expect(cmd.at(-1)?.toLowerCase()).toBe(lease.simulatorId);
    if (cmd[1] === options.failCommand) {
      if (options.failure === 'reject') throw new Error('lost execution');
      if (options.failure === 'open') result.process.stdout = stream;
      if (options.failure === 'exit') return { ...result, success: false, error: 'action failed' };
    }
    return {
      ...result,
      output:
        cmd[1] === 'describe-ui'
          ? JSON.stringify({
              elements: [
                {
                  type: 'TextField',
                  role: 'AXTextField',
                  AXLabel: 'Email',
                  AXUniqueId: 'email-field',
                  frame: { x: 10, y: 20, width: 100, height: 40 },
                  enabled: true,
                  children: [],
                },
              ],
            })
          : 'ok',
    };
  });
  return { calls, stream };
}

it('captures unique refs, taps and replaces text within one operation', async () => {
  const { calls } = commands();
  const initial = capture(await call('snapshot_ui'));
  expect(initial.elements[0].ref).toMatch(/^e[1-9][0-9]*$/);
  expect(initial.actions.every((action) => action.elementRef === initial.elements[0].ref)).toBe(
    true,
  );
  const tapped = await call('tap', { elementRef: initial.elements[0].ref });
  expect(tapped.structuredOutput?.result.didError).toBe(false);
  const refreshed = capture(tapped);
  expect(refreshed.elements[0].ref).not.toBe(initial.elements[0].ref);
  const typed = await call('type_text', {
    elementRef: refreshed.elements[0].ref,
    text: 'hello world',
    replaceExisting: true,
  });
  expect(typed.structuredOutput?.result.didError).toBe(false);
  expect(calls.filter((cmd) => cmd[1] !== 'describe-ui').map((cmd) => cmd[1])).toEqual([
    'tap',
    'tap',
    'key-combo',
    'type',
  ]);
  expect(typed.nextSteps).toEqual([]);
  expect((await manager.end(lease)).state).toBe('released');
});

it('always returns full managed captures and rejects refs from previous captures', async () => {
  const { calls } = commands();
  const first = capture(await call('snapshot_ui'));
  const second = capture(await call('snapshot_ui', { sinceScreenHash: first.screenHash }));
  expect(second.screenHash).toBe(first.screenHash);
  expect(second.elements[0].ref).not.toBe(first.elements[0].ref);
  const before = calls.length;
  const stale = await call('tap', { elementRef: first.elements[0].ref });
  expect(stale.structuredOutput?.result.didError).toBe(true);
  expect(calls).toHaveLength(before);
});

it('invalidates refs on a new operation even while the previous session stays alive', async () => {
  const { calls } = commands();
  const initial = capture(await call('snapshot_ui'));
  const binding = await manager.getBinding((await manager.getStatus(lease.requestId)).generation);
  if (!binding) throw new Error('Missing binding');
  await manager.end(lease);
  lease = await manager.requestLease({
    requestId: randomUUID(),
    owner: { sessionId: randomUUID() },
    worktree: binding.worktree,
  });
  const before = calls.length;
  expect(
    (await call('tap', { elementRef: initial.elements[0].ref })).structuredOutput?.result.didError,
  ).toBe(true);
  expect(calls).toHaveLength(before);
  const fresh = capture(await call('snapshot_ui'));
  expect(
    (await call('tap', { elementRef: fresh.elements[0].ref })).structuredOutput?.result.didError,
  ).toBe(false);
});

it('invalidates after another runtime completes a call using the same operation', async () => {
  const { calls } = commands();
  const initial = capture(await call('snapshot_ui'));
  const status = await manager.getStatus(lease.requestId);
  const activity = {
    id: randomUUID(),
    runtimeId: randomUUID(),
    kind: 'call' as const,
    pid: process.pid,
  };
  expect(
    await manager.startCall(
      lease,
      { generation: status.generation, simulatorId: lease.simulatorId },
      activity,
    ),
  ).toBe(true);
  await manager.finishActivity(lease, activity.id, activity.runtimeId);
  const before = calls.length;
  expect(
    (await call('tap', { elementRef: initial.elements[0].ref })).structuredOutput?.result.didError,
  ).toBe(true);
  expect(calls).toHaveLength(before);
});

it('invalidates across relaunch including mixed UUID casing', async () => {
  const { calls } = commands();
  const initial = capture(
    await call('snapshot_ui', { simulatorId: lease.simulatorId.toUpperCase() }),
  );
  await call('launch_app_sim', { bundleId: 'com.example.App' });
  const before = calls.length;
  expect(
    (
      await call('tap', {
        elementRef: initial.elements[0].ref,
        simulatorId: lease.simulatorId.toUpperCase(),
      })
    ).structuredOutput?.result.didError,
  ).toBe(true);
  expect(calls).toHaveLength(before);
});

it.each(['open', 'reject'] as const)(
  'blocks and stops follow-up typing after uncertain focus: %s',
  async (failure) => {
    commands();
    const initial = capture(await call('snapshot_ui'));
    const { calls, stream } = commands({ failure, failCommand: 'tap' });
    try {
      await expect(
        call('type_text', {
          elementRef: initial.elements[0].ref,
          text: 'hello',
          replaceExisting: true,
        }),
      ).rejects.toThrow('completion could not be confirmed');
      expect(calls.map((cmd) => cmd[1])).toEqual(['tap']);
      await expect(manager.end(lease)).rejects.toThrow(
        'Operation is blocked; end/cancel cannot recover it',
      );
    } finally {
      stream.destroy();
    }
  },
);

it('blocks when refreshed capture completion is uncertain after a successful tap', async () => {
  commands();
  const initial = capture(await call('snapshot_ui'));
  const { calls, stream } = commands({ failure: 'open', failCommand: 'describe-ui' });
  try {
    await expect(call('tap', { elementRef: initial.elements[0].ref })).rejects.toThrow(
      'completion could not be confirmed',
    );
    expect(calls.map((cmd) => cmd[1])).toEqual(['tap', 'describe-ui']);
    await expect(manager.end(lease)).rejects.toThrow(
      'Operation is blocked; end/cancel cannot recover it',
    );
  } finally {
    stream.destroy();
  }
});

it('keeps observed command failure as a domain failure permitting end', async () => {
  commands();
  const initial = capture(await call('snapshot_ui'));
  commands({ failure: 'exit', failCommand: 'tap' });
  expect(
    (await call('tap', { elementRef: initial.elements[0].ref })).structuredOutput?.result.didError,
  ).toBe(true);
  expect((await manager.end(lease)).state).toBe('released');
});

it('surfaces missing AXe as infrastructure failure without occupying the device indefinitely', async () => {
  commands();
  vi.mocked(defaultAxeHelpers.getAxePath).mockReturnValue(null);
  await expect(call('snapshot_ui')).rejects.toThrow('AXe binary not found');
  expect((await manager.end(lease)).state).toBe('released');
});

it('holds closing through post-action capture before handing off', async () => {
  commands();
  const initial = capture(await call('snapshot_ui'));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  commands({
    onCommand: async (cmd) => {
      if (cmd[1] === 'describe-ui') {
        entered();
        await finish;
      }
    },
  });
  const callPromise = call('tap', { elementRef: initial.elements[0].ref });
  await started;
  expect((await manager.end(lease)).state).toBe('closing');
  release();
  await callPromise;
  expect((await manager.getStatus(lease.requestId)).state).toBe('released');
});

it('checks credentials and target before any UI command', async () => {
  const { calls } = commands();
  for (const name of ['snapshot_ui', 'tap', 'type_text'] as const) {
    expect(managedToolSchema(`mcp/tools/ui-automation/${name}`, {})).toHaveProperty(
      'operationToken',
    );
    await expect(
      call(name, { elementRef: 'e1', text: 'hello', operationToken: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      call(name, { elementRef: 'e1', text: 'hello', simulatorId: randomUUID() }),
    ).rejects.toThrow();
  }
  expect(calls).toEqual([]);
});

it('serializes ordinary UI transactions for differently cased UUIDs sharing one cache', async () => {
  let active = 0;
  let maximum = 0;
  const transaction = async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
  };
  await Promise.all([
    withSimulatorUiAutomationTransaction(lease.simulatorId.toLowerCase(), transaction),
    withSimulatorUiAutomationTransaction(lease.simulatorId.toUpperCase(), transaction),
  ]);
  expect(maximum).toBe(1);
});

it('renders managed guidance from final metadata without changing ordinary guidance', async () => {
  commands();
  const ctx = await call('snapshot_ui');
  const output = ctx.structuredOutput;
  if (!output) throw new Error('Missing result');
  const managed = renderCliTextTranscript({ structuredOutput: output });
  expect(managed).toContain('same operation credentials');
  expect(managed).not.toContain('wait_for_ui');
  expect(managed).not.toContain('long_press');
  const ordinary = renderCliTextTranscript({
    structuredOutput: { ...output, renderHints: undefined },
  });
  expect(ordinary).toContain('wait_for_ui');
});
