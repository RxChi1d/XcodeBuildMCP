import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMockExecutor } from '../../test-utils/mock-executors.ts';
import {
  __setTestCommandExecutorOverride,
  __clearTestExecutorOverrides,
} from '../../utils/command.ts';
import {
  createSessionAwareToolWithContext,
  getHandlerContext,
} from '../../utils/typed-tool-factory.ts';
import { sessionStore } from '../../utils/session-store.ts';
import type { ToolHandlerContext } from '../../rendering/types.ts';
import { resourceEnvironment, assertResourceNamespace } from '../environment.ts';
import { managedToolSchema, wrapManagedTool } from '../tool-gate.ts';
import { SimulatorResourceManager, type Lease } from '../manager.ts';
import { resolveManagedWorktree } from '../worktree.ts';
import { handler as operation } from '../../mcp/tools/resource-management/resource_operation.ts';
import { renderCliTextTranscript } from '../../utils/renderers/cli-text-renderer.ts';
import { supervisedExecutor } from '../execution.ts';
import { assertManagedSocketPath, getSocketPath } from '../../daemon/socket-path.ts';
import {
  configureRuntimeWorkspaceKey,
  setRuntimeInstanceForTests,
} from '../../utils/runtime-instance.ts';
import { workspaceKeyForRoot } from '../../utils/workspace-identity.ts';

let directory: string;
let manager: SimulatorResourceManager;
let lease: Lease;
const moduleId = 'mcp/tools/ui-automation/screenshot';
const schema = z.object({ simulatorId: z.uuid() });
const context = (): ToolHandlerContext => ({ emit: () => {}, attach: () => {} });
const credentials = () => ({
  operationRequestId: lease.requestId,
  operationToken: lease.token,
  operationSessionId: lease.sessionId,
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-gate-'));
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
  sessionStore.clear();
});

afterEach(async () => {
  __clearTestExecutorOverrides();
  sessionStore.clear();
  vi.unstubAllEnvs();
  setRuntimeInstanceForTests(null);
  await rm(directory, { recursive: true, force: true });
});

function tool(logic: () => Promise<void>) {
  const handler = createSessionAwareToolWithContext({
    internalSchema: schema,
    logicFunction: logic,
    getContext: () => undefined,
  });
  return wrapManagedTool(moduleId, (args, ctx) => {
    if (!ctx) throw new Error('Missing fixture context');
    return handler(args, ctx);
  });
}

function succeed(): void {
  getHandlerContext().structuredOutput = {
    schema: 'xcodebuildmcp.output.capture-result',
    schemaVersion: '2',
    result: {
      kind: 'capture-result',
      didError: false,
      error: null,
      summary: { status: 'SUCCEEDED' },
      artifacts: { simulatorId: lease.simulatorId },
    },
  };
}

it('checks the final default target before invoking any device work', async () => {
  const logic = vi.fn(async () => succeed());
  sessionStore.setDefaults({ simulatorId: randomUUID() });
  await expect(tool(logic)(credentials(), context())).rejects.toThrow('Effective target');
  expect(logic).not.toHaveBeenCalled();
  sessionStore.setDefaults({ simulatorId: lease.simulatorId.toUpperCase() });
  await tool(logic)(credentials(), context());
  expect(logic).toHaveBeenCalledOnce();
  expect((await manager.getStatus(lease.requestId)).activities).toHaveLength(0);
});

it('keeps the operation held after a call and drains end before handing off', async () => {
  let release!: () => void;
  let admitted!: () => void;
  const started = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = tool(async () => {
    admitted();
    await finish;
    succeed();
  })({ ...credentials(), simulatorId: lease.simulatorId }, context());
  await started;
  expect((await manager.end(lease)).state).toBe('closing');
  release();
  await call;
  expect((await manager.getStatus(lease.requestId)).state).toBe('released');
  await expect(
    tool(async () => succeed())({ ...credentials(), simulatorId: lease.simulatorId }, context()),
  ).rejects.toThrow('released');
});

it('serializes concurrent tool calls using the same token', async () => {
  let inFlight = 0;
  let maximum = 0;
  const run = tool(async () => {
    maximum = Math.max(maximum, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight--;
    succeed();
  });
  await Promise.all([
    run({ ...credentials(), simulatorId: lease.simulatorId }, context()),
    run({ ...credentials(), simulatorId: lease.simulatorId }, context()),
  ]);
  expect(maximum).toBe(1);
  expect((await manager.getStatus(lease.requestId)).state).toBe('active');
});

it.each(['rejection', 'open-stream'])(
  'blocks uncertain command completion even when logic swallows it: %s',
  async (failure) => {
    const stream = new PassThrough();
    const execute = supervisedExecutor(
      createMockExecutor(
        failure === 'rejection'
          ? { shouldThrow: new Error('lost supervision') }
          : {
              process: {
                exitCode: 0,
                signalCode: null,
                stdout: stream,
                stderr: null,
              } as unknown as ChildProcess,
            },
      ),
    );
    const run = tool(async () => {
      try {
        await execute(['fixture-command']);
      } catch {
        /* Existing helpers may swallow failures. */
      }
      succeed();
    });
    await expect(
      run({ ...credentials(), simulatorId: lease.simulatorId }, context()),
    ).rejects.toThrow();
    await expect(manager.end(lease)).rejects.toThrow(
      'Operation is blocked; end/cancel cannot recover it',
    );
    expect((await manager.getStatus(lease.requestId)).activities).toHaveLength(1);
    stream.destroy();
  },
);

it('preserves domain failures after observed completion and permits explicit end', async () => {
  const execute = supervisedExecutor(createMockExecutor({ success: false, exitCode: 1 }));
  const ctx = context();
  await tool(async () => {
    await execute(['fixture-command']);
    succeed();
    getHandlerContext().structuredOutput!.result.didError = true;
  })({ ...credentials(), simulatorId: lease.simulatorId }, ctx);
  expect(ctx.structuredOutput?.result.didError).toBe(true);
  expect((await manager.end(lease)).state).toBe('released');
});

it('does not permanently occupy a device for a preflight failure without commands', async () => {
  await tool(async () => {
    succeed();
    getHandlerContext().structuredOutput!.result.didError = true;
  })({ ...credentials(), simulatorId: lease.simulatorId }, context());
  expect((await manager.end(lease)).state).toBe('released');
});

it('rejects missing credentials, unsupported tools and disabled recipients', async () => {
  const handler = vi.fn(async () => {});
  await expect(wrapManagedTool(moduleId, handler)({}, context())).rejects.toThrow('credentials');
  await expect(
    wrapManagedTool('mcp/tools/simulator/clean_sim', handler)(credentials(), context()),
  ).rejects.toThrow('not yet supported');
  expect(managedToolSchema(moduleId, schema.shape)).toHaveProperty('operationToken');
  expect(managedToolSchema(moduleId, {})).toHaveProperty('simulatorId');
  vi.stubEnv('XCODEBUILDMCP_OPERATION_STATE_ROOT', undefined);
  vi.stubEnv('XCODEBUILDMCP_OPERATION_CAPACITY', undefined);
  await expect(wrapManagedTool(moduleId, handler)(credentials(), context())).rejects.toThrow(
    'require managed',
  );
  expect(handler).not.toHaveBeenCalled();
});

it('returns durable management results, redacts status, and renders final state without fragments', async () => {
  const ctx = context();
  await operation({ action: 'status', requestId: lease.requestId }, ctx);
  expect(ctx.structuredOutput?.result).not.toHaveProperty('token');
  expect(renderCliTextTranscript({ structuredOutput: ctx.structuredOutput })).toContain(
    'State: active',
  );
  await operation(
    { action: 'end', requestId: lease.requestId, sessionId: lease.sessionId, token: lease.token },
    ctx,
  );
  expect(ctx.structuredOutput?.result).toMatchObject({ state: 'released', activityCount: 0 });
});

it('requires a complete opt-in and matching daemon capability', () => {
  expect(() => assertResourceNamespace(undefined)).toThrow('namespace mismatch');
  assertResourceNamespace(resourceEnvironment()!.namespace);
  vi.stubEnv('XCODEBUILDMCP_OPERATION_CAPACITY', undefined);
  expect(() => resourceEnvironment()).toThrow('require');
});

it('validates sockets against the bootstrapped workspace when invoked from a subdirectory', () => {
  const root = join(directory, 'checkout');
  configureRuntimeWorkspaceKey(workspaceKeyForRoot(root));
  const socket = getSocketPath({
    cwd: join(root, 'src'),
    projectConfigPath: join(root, '.xcodebuildmcp', 'config.yaml'),
  });
  expect(() => assertManagedSocketPath(socket)).not.toThrow();
  expect(() => assertManagedSocketPath('/tmp/foreign.sock')).toThrow('isolated');
});
