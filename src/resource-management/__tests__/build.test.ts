import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockExecutor } from '../../test-utils/mock-executors.ts';
import {
  __setTestCommandExecutorOverride,
  __clearTestExecutorOverrides,
} from '../../utils/command.ts';
import type { ToolHandlerContext } from '../../rendering/types.ts';
import { sessionStore } from '../../utils/session-store.ts';
import { resourceEnvironment } from '../environment.ts';
import { managedToolSchema, wrapManagedTool } from '../tool-gate.ts';
import { SimulatorResourceManager, type Lease } from '../manager.ts';
import { resolveManagedWorktree } from '../worktree.ts';
import {
  handler as buildHandler,
  schema as buildSchema,
} from '../../mcp/tools/simulator/build_sim.ts';
import { handler as snapshotHandler } from '../../mcp/tools/ui-automation/snapshot_ui.ts';
import { defaultAxeHelpers } from '../../mcp/tools/ui-automation/shared/axe-command.ts';
import * as xcodemakeModule from '../../utils/xcodemake.ts';
import * as logCaptureModule from '../../utils/xcodebuild-log-capture.ts';
import {
  getRuntimeSnapshotLookup,
  __resetRuntimeSnapshotStoreForTests,
} from '../../mcp/tools/ui-automation/shared/snapshot-ui-state.ts';

let directory: string;
let manager: SimulatorResourceManager;
let lease: Lease;
let logsDir: string;
const moduleId = 'mcp/tools/simulator/build_sim';
const context = (): ToolHandlerContext => ({ emit: () => {}, attach: () => {} });

const credentials = () => ({
  simulatorId: lease.simulatorId,
  operationRequestId: lease.requestId,
  operationToken: lease.token,
  operationSessionId: lease.sessionId,
});

const defaultBuildParams = (root: string) => ({
  ...credentials(),
  projectPath: join(root, 'TestApp.xcodeproj'),
  scheme: 'TestApp',
});

const build = wrapManagedTool(moduleId, (args, ctx) => {
  if (!ctx) throw new Error('Missing fixture context');
  return buildHandler(args, ctx);
});

beforeEach(async () => {
  __resetRuntimeSnapshotStoreForTests();
  sessionStore.clear();
  directory = await mkdtemp(join(tmpdir(), 'resource-build-'));
  const root = join(directory, 'checkout');
  await mkdir(join(root, '.git'), { recursive: true });
  logsDir = join(directory, 'logs');
  await mkdir(logsDir, { recursive: true });
  logCaptureModule.setXcodebuildLogDirOverrideForTests(logsDir);

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
  logCaptureModule.setXcodebuildLogDirOverrideForTests(null);
  sessionStore.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function commands(
  options: {
    failure?: 'exit' | 'reject' | 'open-stream' | 'unknown-exit';
    exitCode?: number;
    error?: string;
    emitOutput?: boolean;
    onBuild?: () => Promise<void>;
  } = {},
) {
  const calls: string[][] = [];
  const stream = new PassThrough();
  const mock = createMockExecutor({});
  const root = join(directory, 'checkout');

  __setTestCommandExecutorOverride(async (...args) => {
    const cmd = args[0];
    const execOpts = args[3];

    if (cmd[0] === 'git') {
      return {
        ...(await mock(...args)),
        output: `${cmd.at(-1) === '--show-toplevel' ? root : join(root, '.git')}\n`,
      };
    }

    if (cmd[0] === 'xcrun' && cmd[1] === 'simctl') {
      calls.push(cmd);
      return {
        ...(await mock(...args)),
        output: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              {
                udid: lease.simulatorId.toUpperCase(),
                name: 'iPhone 16 Pro',
                isAvailable: true,
                state: 'Booted',
              },
            ],
          },
        }),
      };
    }

    if (cmd[0] === 'xcodebuild') {
      calls.push(cmd);

      const destIndex = cmd.indexOf('-destination');
      if (destIndex !== -1) {
        const dest = cmd[destIndex + 1] ?? '';
        const idMatch = dest.match(/id=([^,]+)/);
        if (idMatch && idMatch[1] !== lease.simulatorId.toUpperCase()) {
          return createMockExecutor({
            success: false,
            exitCode: 70,
            error: `xcodebuild: error: Unable to find a device matching the provided destination specifier: { ${dest} }`,
          })(...args);
        }
      }

      if (options.emitOutput && execOpts?.onStdout) {
        execOpts.onStdout(
          '=== BUILD TARGET TestApp OF PROJECT TestApp ===\nCompileSwift normal ...\n',
        );
      }

      await options.onBuild?.();

      if (options.failure === 'reject') {
        throw new Error('lost executor');
      }

      if (options.failure === 'exit') {
        return createMockExecutor({
          success: false,
          exitCode: options.exitCode ?? 65,
          error: options.error ?? 'Build failed',
        })(...args);
      }

      const response = await mock(...args);
      if (options.failure === 'open-stream') {
        response.process.stdout = stream;
      }
      if (options.failure === 'unknown-exit') {
        Object.assign(response.process, { exitCode: null, signalCode: null });
      }

      return response;
    }

    if (cmd[0] === '/fixture/axe') {
      calls.push(cmd);
      return {
        ...(await mock(...args)),
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
    }

    throw new Error(`Unexpected external command in test mock: ${cmd.join(' ')}`);
  });

  return { calls, stream, root };
}

describe('Managed build_sim', () => {
  it('exposes explicit project, workspace, scheme, and credentials on public managed schema', () => {
    const schema = managedToolSchema(moduleId, buildSchema);
    expect(schema).toHaveProperty('projectPath');
    expect(schema).toHaveProperty('workspacePath');
    expect(schema).toHaveProperty('scheme');
    expect(schema).toHaveProperty('configuration');
    expect(schema).toHaveProperty('derivedDataPath');
    expect(schema).toHaveProperty('preferXcodebuild');
    expect(schema).toHaveProperty('simulatorId');
    expect(schema).toHaveProperty('operationRequestId');
    expect(schema).toHaveProperty('operationToken');
    expect(schema).toHaveProperty('operationSessionId');
  });

  it('rejects raw source defaults and invalid source fields before commands or activities', async () => {
    const { calls, root } = commands();
    const base = {
      ...credentials(),
      scheme: 'TestApp',
    };

    sessionStore.setDefaults({
      projectPath: join(root, 'TestApp.xcodeproj'),
      scheme: 'TestApp',
    });
    await expect(build(base, context())).rejects.toThrow(
      'Managed builds require exactly one of projectPath or workspacePath',
    );
    sessionStore.clear();

    await expect(
      build(
        {
          ...base,
          projectPath: join(root, 'TestApp.xcodeproj'),
          workspacePath: ' ',
        },
        context(),
      ),
    ).rejects.toThrow('Managed builds do not allow blank workspacePath');
    await expect(
      build(
        {
          ...base,
          projectPath: '\t',
          workspacePath: join(root, 'TestApp.xcworkspace'),
        },
        context(),
      ),
    ).rejects.toThrow('Managed builds do not allow blank projectPath');

    sessionStore.setDefaults({ scheme: 'DefaultScheme' });
    await expect(
      build(
        {
          ...credentials(),
          projectPath: join(root, 'TestApp.xcodeproj'),
        },
        context(),
      ),
    ).rejects.toThrow('Managed builds require an explicit non-empty scheme');
    sessionStore.clear();

    sessionStore.setDefaults({ simulatorId: lease.simulatorId });
    await expect(
      build(
        {
          operationRequestId: lease.requestId,
          operationToken: lease.token,
          operationSessionId: lease.sessionId,
          projectPath: join(root, 'TestApp.xcodeproj'),
          scheme: 'TestApp',
        },
        context(),
      ),
    ).rejects.toThrow('Managed builds require an explicit simulatorId');
    sessionStore.clear();

    await expect(build({ ...base, projectPath: '  ' }, context())).rejects.toThrow(
      'Managed builds do not allow blank projectPath',
    );
    await expect(build({ ...base, workspacePath: '\t' }, context())).rejects.toThrow(
      'Managed builds do not allow blank workspacePath',
    );
    await expect(
      build(
        {
          ...base,
          projectPath: join(root, 'TestApp.xcodeproj'),
          workspacePath: join(root, 'TestApp.xcworkspace'),
        },
        context(),
      ),
    ).rejects.toThrow('Managed builds require exactly one of projectPath or workspacePath');
    await expect(
      build({ ...base, projectPath: join(root, 'TestApp.xcodeproj'), scheme: '  ' }, context()),
    ).rejects.toThrow('Managed builds require an explicit non-empty scheme');
    await expect(
      build(
        { ...base, projectPath: join(root, 'TestApp.xcodeproj'), simulatorId: 'invalid' },
        context(),
      ),
    ).rejects.toThrow('Managed calls require a resolved Simulator UUID without a name');
    await expect(
      build(
        {
          ...base,
          projectPath: join(root, 'TestApp.xcodeproj'),
          simulatorName: 'iPhone 16 Pro',
        },
        context(),
      ),
    ).rejects.toThrow('Managed calls require a resolved Simulator UUID without a name');

    expect(calls).toHaveLength(0);
    expect((await manager.getStatus(lease.requestId)).activities).toHaveLength(0);
  });

  it('rejects missing credentials, wrong token, wrong session, foreign UUID, and simulatorName before build', async () => {
    const { calls, root } = commands();
    const baseParams = {
      projectPath: join(root, 'TestApp.xcodeproj'),
      scheme: 'TestApp',
    };

    // Missing credentials
    await expect(
      build({ ...baseParams, simulatorId: lease.simulatorId }, context()),
    ).rejects.toThrow('credentials');

    // Wrong token
    await expect(
      build({ ...baseParams, ...credentials(), operationToken: randomUUID() }, context()),
    ).rejects.toThrow();

    // Wrong session
    await expect(
      build({ ...baseParams, ...credentials(), operationSessionId: randomUUID() }, context()),
    ).rejects.toThrow();

    // Foreign UUID
    await expect(
      build({ ...baseParams, ...credentials(), simulatorId: randomUUID() }, context()),
    ).rejects.toThrow();

    // simulatorName provided without simulatorId
    const credsWithoutSimId = {
      operationRequestId: lease.requestId,
      operationToken: lease.token,
      operationSessionId: lease.sessionId,
    };
    await expect(
      build({ ...baseParams, ...credsWithoutSimId, simulatorName: 'iPhone 16 Pro' }, context()),
    ).rejects.toThrow('without a name');

    // simulatorName provided alongside simulatorId is rejected before admission
    await expect(
      build({ ...baseParams, ...credentials(), simulatorName: 'iPhone 16 Pro' }, context()),
    ).rejects.toThrow('without a name');

    expect(calls).toHaveLength(0);
  });

  it('rejects nonempty extraArgs (including session defaults), buildForTesting, testProductsPath, and preferXcodebuild=false', async () => {
    const { calls, root } = commands();
    const base = defaultBuildParams(root);

    // Direct non-empty extraArgs
    await expect(build({ ...base, extraArgs: ['-verbose'] }, context())).rejects.toThrow(
      'extraArgs',
    );

    // Inherited non-empty extraArgs from session defaults
    sessionStore.setDefaults({ extraArgs: ['-inherited'] });
    await expect(build(base, context())).rejects.toThrow('extraArgs');
    sessionStore.clear();

    // testProductsPath provided (with buildForTesting=true to pass schema validation)
    await expect(
      build(
        { ...base, testProductsPath: '/tmp/products.xctestproducts', buildForTesting: true },
        context(),
      ),
    ).rejects.toThrow();

    // buildForTesting = true without testProductsPath
    await expect(build({ ...base, buildForTesting: true }, context())).rejects.toThrow(
      'buildForTesting',
    );

    // Direct preferXcodebuild = false
    await expect(build({ ...base, preferXcodebuild: false }, context())).rejects.toThrow(
      'preferXcodebuild=false',
    );

    // Inherited preferXcodebuild = false from session defaults
    sessionStore.setDefaults({ preferXcodebuild: false });
    await expect(build(base, context())).rejects.toThrow('preferXcodebuild=false');
    sessionStore.clear();

    // No build commands executed during rejected admissions
    expect(calls).toHaveLength(0);
  });

  it('allows empty extraArgs and omitted/true preferXcodebuild with explicit workspace', async () => {
    const { calls, root } = commands();
    const ctx = context();

    await build(
      {
        ...credentials(),
        workspacePath: join(root, 'TestApp.xcworkspace'),
        scheme: 'TestApp',
        extraArgs: [],
        preferXcodebuild: true,
      },
      ctx,
    );

    expect(ctx.structuredOutput?.result.didError).toBe(false);
    const xcodebuildCall = calls.find((c) => c[0] === 'xcodebuild');
    expect(xcodebuildCall).toBeDefined();
    expect(xcodebuildCall).toContain('-workspace');
    expect(xcodebuildCall).toContain(join(root, 'TestApp.xcworkspace'));
    expect(xcodebuildCall).toContain('-scheme');
    expect(xcodebuildCall).toContain('TestApp');
  });

  it('binds uppercase destination matching catalog despite lowercase lease ID', async () => {
    const { calls, root } = commands();
    const ctx = context();

    await build(defaultBuildParams(root), ctx);

    const xcodebuildCall = calls.find((c) => c[0] === 'xcodebuild');
    expect(xcodebuildCall).toBeDefined();
    const destIndex = xcodebuildCall!.indexOf('-destination');
    expect(destIndex).toBeGreaterThan(-1);
    expect(xcodebuildCall![destIndex + 1]).toBe(
      `platform=iOS Simulator,id=${lease.simulatorId.toUpperCase()}`,
    );
  });

  it('bypasses xcodemake probe and execution even when xcodemake is enabled', async () => {
    const enabledSpy = vi.spyOn(xcodemakeModule, 'isXcodemakeEnabled').mockReturnValue(true);
    expect(xcodemakeModule.isXcodemakeEnabled()).toBe(true);
    const availableSpy = vi.spyOn(xcodemakeModule, 'isXcodemakeAvailable');
    const executeSpy = vi.spyOn(xcodemakeModule, 'executeXcodemakeCommand');

    const { calls, root } = commands();
    const ctx = context();

    await build(defaultBuildParams(root), ctx);

    expect(availableSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();

    const xcodebuildCall = calls.find((c) => c[0] === 'xcodebuild');
    expect(xcodebuildCall).toBeDefined();
    expect(xcodebuildCall![0]).toBe('xcodebuild');
    enabledSpy.mockRestore();
  });

  it('keeps lease active on successful build and confirmed compile failure, releasing upon explicit end', async () => {
    const { root } = commands();
    const ctxSuccess = context();

    await build(defaultBuildParams(root), ctxSuccess);
    expect(ctxSuccess.structuredOutput?.result.didError).toBe(false);
    expect((await manager.getStatus(lease.requestId)).state).toBe('active');
    expect((await manager.end(lease)).state).toBe('released');

    // Acquire new lease for compile failure test
    const binding = await manager.getBinding((await manager.getStatus(lease.requestId)).generation);
    if (!binding) throw new Error('Missing fixture binding');
    lease = await manager.requestLease({
      requestId: randomUUID(),
      owner: { sessionId: randomUUID() },
      worktree: binding.worktree,
    });

    commands({ failure: 'exit', exitCode: 65, error: 'Compile error' });
    const ctxFailure = context();
    await build(defaultBuildParams(root), ctxFailure);
    expect(ctxFailure.structuredOutput?.result.didError).toBe(true);
    expect(ctxFailure.structuredOutput?.result.error).toBe('Build failed');
    expect((await manager.getStatus(lease.requestId)).state).toBe('active');
    expect((await manager.end(lease)).state).toBe('released');
  });

  it.each(['reject', 'open-stream', 'unknown-exit'] as const)(
    'blocks lease on %s failure',
    async (failure) => {
      const { stream, root } = commands({ failure });
      try {
        await expect(build(defaultBuildParams(root), context())).rejects.toThrow();
        expect((await manager.getStatus(lease.requestId)).state).toBe('blocked');
        await expect(manager.end(lease)).rejects.toThrow(
          'Operation is blocked; end/cancel cannot recover it',
        );
      } finally {
        stream.destroy();
      }
    },
  );

  it('closes log file descriptor and preserves emitted output when executor rejects', async () => {
    let captureClosed = false;
    let capturedLogPath: string | null = null;
    const origCreate = logCaptureModule.createLogCapture;
    vi.spyOn(logCaptureModule, 'createLogCapture').mockImplementation((toolName) => {
      const cap = origCreate(toolName);
      capturedLogPath = cap.path;
      const origClose = cap.close.bind(cap);
      cap.close = () => {
        captureClosed = true;
        origClose();
      };
      return cap;
    });

    const { root } = commands({ failure: 'reject', emitOutput: true });

    await expect(build(defaultBuildParams(root), context())).rejects.toThrow(
      'completion could not be confirmed',
    );

    // Evidence of pipeline finalization and log closure
    expect(captureClosed).toBe(true);

    // Verify log file was written and closed
    expect(capturedLogPath).not.toBeNull();
    const content = await readFile(capturedLogPath!, 'utf8');
    expect(content).toContain('=== BUILD TARGET TestApp OF PROJECT TestApp ===');

    expect((await manager.getStatus(lease.requestId)).state).toBe('blocked');
  });

  it('keeps closing operation held until build completes before granting waiting session', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { root } = commands({
      onBuild: async () => {
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

    const run = build(defaultBuildParams(root), context());
    await started;

    expect((await manager.end(lease)).state).toBe('closing');
    expect((await manager.poll(waiting)).state).toBe('waiting');

    release();
    await run;

    expect((await manager.getStatus(lease.requestId)).state).toBe('released');
    expect((await manager.poll(waiting)).state).toBe('active');
  });

  it('invalidates previous UI snapshot on admission and suppresses next-step metadata', async () => {
    vi.spyOn(defaultAxeHelpers, 'getAxePath').mockReturnValue('/fixture/axe');
    vi.spyOn(defaultAxeHelpers, 'getBundledAxeEnvironment').mockReturnValue({});

    let snapshotStatusDuringBuild: string | undefined;

    const { root } = commands({
      onBuild: async () => {
        // Assert snapshot is already missing during build execution (invalidated upon admission)
        snapshotStatusDuringBuild = getRuntimeSnapshotLookup(lease.simulatorId).status;
      },
    });

    // Take a valid snapshot via real managed snapshot_ui handler first to establish provenance
    const snapshotCtx = context();
    const snapshotTool = wrapManagedTool('mcp/tools/ui-automation/snapshot_ui', (args, ctx) => {
      if (!ctx) throw new Error('Missing fixture context');
      return snapshotHandler(args, ctx);
    });
    await snapshotTool(credentials(), snapshotCtx);

    expect(getRuntimeSnapshotLookup(lease.simulatorId).status).toBe('available');

    const ctx = context();
    await build(defaultBuildParams(root), ctx);

    // Snapshot must be invalidated upon build admission (both during and after execution)
    expect(snapshotStatusDuringBuild).toBe('missing');
    expect(getRuntimeSnapshotLookup(lease.simulatorId).status).toBe('missing');

    // Structured result retains schema version 3
    expect(ctx.structuredOutput?.schemaVersion).toBe('3');
    expect(ctx.structuredOutput?.result.kind).toBe('build-result');

    // All next-step metadata suppressed
    expect(ctx.nextSteps).toEqual([]);
    expect(ctx.nextStepParams).toBeUndefined();
    expect(ctx.nextStepConditionKeys).toBeUndefined();
  });
});
