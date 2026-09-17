import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
  handler as testSimHandler,
  schema as testSimSchema,
  mcpSchema as testSimMcpSchema,
} from '../../mcp/tools/simulator/test_sim.ts';
import { handler as snapshotHandler } from '../../mcp/tools/ui-automation/snapshot_ui.ts';
import { defaultAxeHelpers } from '../../mcp/tools/ui-automation/shared/axe-command.ts';
import * as logCaptureModule from '../../utils/xcodebuild-log-capture.ts';
import * as xcresultModule from '../../utils/xcresult-test-failures.ts';
import * as resultBundleModule from '../../utils/result-bundle-path.ts';
import * as testProductsModule from '../../utils/test-products-path.ts';
import {
  getRuntimeSnapshotLookup,
  __resetRuntimeSnapshotStoreForTests,
} from '../../mcp/tools/ui-automation/shared/snapshot-ui-state.ts';
import { SimulatorTestUncertainError } from '../test-execution.ts';

let directory: string;
let manager: SimulatorResourceManager;
let lease: Lease;
let logsDir: string;
let activeStreams: PassThrough[] = [];
const moduleId = 'mcp/tools/simulator/test_sim';
const context = (): ToolHandlerContext => ({ emit: () => {}, attach: () => {} });

const credentials = () => ({
  simulatorId: lease.simulatorId,
  operationRequestId: lease.requestId,
  operationToken: lease.token,
  operationSessionId: lease.sessionId,
});

const defaultTestParams = (root: string) => ({
  ...credentials(),
  projectPath: join(root, 'TestApp.xcodeproj'),
  scheme: 'TestApp',
});

const testTool = wrapManagedTool(moduleId, (args, ctx) => {
  if (!ctx) throw new Error('Missing fixture context');
  return testSimHandler(args, ctx);
});

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  __resetRuntimeSnapshotStoreForTests();
  sessionStore.clear();
  directory = await mkdtemp(join(tmpdir(), 'resource-test-'));
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
  for (const s of activeStreams) {
    s.destroy();
  }
  activeStreams = [];
  __clearTestExecutorOverrides();
  logCaptureModule.setXcodebuildLogDirOverrideForTests(null);
  sessionStore.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function setupSyncExtractSentinels() {
  const summarySpy = vi
    .spyOn(xcresultModule, 'extractTestSummaryCountsFromXcresult')
    .mockImplementation(() => {
      throw new Error(
        'SENTINEL: extractTestSummaryCountsFromXcresult sync function must never be called in managed mode',
      );
    });
  const failuresSpy = vi
    .spyOn(xcresultModule, 'extractTestFailuresFromXcresult')
    .mockImplementation(() => {
      throw new Error(
        'SENTINEL: extractTestFailuresFromXcresult sync function must never be called in managed mode',
      );
    });
  return { summarySpy, failuresSpy };
}

function commands(
  options: {
    phase1Failure?: 'exit' | 'reject' | 'signal';
    phase2Failure?: 'exit' | 'reject' | 'open-stream' | 'unknown-exit' | 'signal';
    phase1ExitCode?: number;
    phase2ExitCode?: number;
    shutdownFailure?: 'exit' | 'reject';
    postCatalogState?: string;
    metadataFailure?: 'reject' | 'signal-tests' | 'signal-summary';
    onShutdown?: () => Promise<void>;
    onPostList?: () => Promise<void>;
    capturedEnvs?: Record<string, string | undefined>[];
    xcresultFailures?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  const stream = new PassThrough();
  activeStreams.push(stream);
  const mock = createMockExecutor({});
  const root = join(directory, 'checkout');
  let simState = 'Booted';
  let hasShutDown = false;
  let observingTestAdmission = false;
  let firstDeviceCallSnapshotStatus: string | undefined;

  const recordDeviceCall = () => {
    if (observingTestAdmission && firstDeviceCallSnapshotStatus === undefined) {
      firstDeviceCallSnapshotStatus = getRuntimeSnapshotLookup(lease.simulatorId).status;
    }
  };

  __setTestCommandExecutorOverride(async (...args) => {
    const cmd = args[0];
    const execOpts = args[3];

    if (execOpts?.env) {
      options.capturedEnvs?.push(execOpts.env);
    }

    if (cmd[0] === 'git') {
      return {
        ...(await mock(...args)),
        output: `${cmd.at(-1) === '--show-toplevel' ? root : join(root, '.git')}\n`,
      };
    }

    if (cmd[0] === 'xcrun' && cmd[1] === 'simctl') {
      recordDeviceCall();
      calls.push(cmd);
      if (cmd[2] === 'list') {
        if (hasShutDown && options.onPostList) {
          await options.onPostList();
        }
        const stateToReport = hasShutDown ? (options.postCatalogState ?? simState) : simState;
        return {
          ...(await mock(...args)),
          output: JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                {
                  udid: lease.simulatorId.toUpperCase(),
                  name: 'iPhone 16 Pro',
                  isAvailable: true,
                  state: stateToReport,
                },
              ],
            },
          }),
        };
      }
      if (cmd[2] === 'shutdown') {
        if (options.onShutdown) {
          await options.onShutdown();
        }
        if (options.shutdownFailure === 'reject') {
          throw new Error('simctl shutdown failed unexpectedly');
        }
        if (options.shutdownFailure === 'exit') {
          return createMockExecutor({
            success: false,
            exitCode: 1,
            error: 'simctl shutdown timed out',
          })(...args);
        }
        simState = 'Shutdown';
        hasShutDown = true;
        return {
          ...(await mock(...args)),
          output: '',
        };
      }
      throw new Error(`Unexpected simctl command in mock: ${cmd.join(' ')}`);
    }

    if (cmd[0] === 'xcrun') {
      calls.push(cmd);
      if (cmd.includes('tests')) {
        if (options.metadataFailure === 'signal-tests') {
          const response = await createMockExecutor({
            success: false,
            exitCode: 1,
            output: 'Interrupted',
          })(...args);
          Object.assign(response.process, { exitCode: null, signalCode: 'SIGTERM' });
          return response;
        }
        if (options.metadataFailure === 'reject') {
          throw new Error('xcresult tests extraction rejected');
        }
        if (options.xcresultFailures) {
          return {
            ...(await mock(...args)),
            output: JSON.stringify({
              testNodes: [
                {
                  name: 'TestAppTests',
                  nodeType: 'Test Suite',
                  children: [
                    {
                      name: 'testFailure()',
                      nodeType: 'Test Case',
                      result: 'Failed',
                      children: [
                        {
                          name: 'XCTAssertTrue failed - Expected true got false',
                          nodeType: 'Failure Message',
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          };
        }
        return {
          ...(await mock(...args)),
          output: JSON.stringify({ testNodes: [] }),
        };
      }
      if (cmd.includes('summary')) {
        if (options.metadataFailure === 'signal-summary') {
          const response = await createMockExecutor({
            success: false,
            exitCode: 1,
            output: 'Interrupted',
          })(...args);
          Object.assign(response.process, { exitCode: null, signalCode: 'SIGTERM' });
          return response;
        }
        if (options.metadataFailure === 'reject') {
          throw new Error('xcresult summary extraction rejected');
        }
        return {
          ...(await mock(...args)),
          output: JSON.stringify({
            totalTestCount: 5,
            passedTests: options.phase2ExitCode === 65 ? 4 : 5,
            failedTests: options.phase2ExitCode === 65 ? 1 : 0,
            skippedTests: 0,
          }),
        };
      }
      throw new Error(`Unexpected xcrun command in mock: ${cmd.join(' ')}`);
    }

    if (cmd[0] === 'xcodebuild') {
      recordDeviceCall();
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

      if (cmd.includes('build-for-testing')) {
        if (options.phase1Failure === 'reject') {
          throw new Error('build-for-testing executor rejected');
        }
        if (options.phase1Failure === 'signal') {
          const res = await createMockExecutor({
            success: false,
            exitCode: 1,
            output: 'Interrupted',
          })(...args);
          Object.assign(res.process, { exitCode: null, signalCode: 'SIGTERM' });
          return res;
        }
        if (options.phase1Failure === 'exit') {
          return createMockExecutor({
            success: false,
            exitCode: options.phase1ExitCode ?? 65,
            error: 'Compilation failed',
          })(...args);
        }
        return mock(...args);
      }

      if (cmd.includes('test-without-building')) {
        if (options.phase2Failure === 'reject') {
          throw new Error('test-without-building executor rejected');
        }
        if (options.phase2Failure === 'signal') {
          const res = await createMockExecutor({
            success: false,
            exitCode: 1,
            output: 'Killed',
          })(...args);
          Object.assign(res.process, { exitCode: null, signalCode: 'SIGKILL' });
          return res;
        }
        if (options.phase2Failure === 'exit') {
          return createMockExecutor({
            success: false,
            exitCode: options.phase2ExitCode ?? 65,
            error: 'Tests failed',
          })(...args);
        }
        const response = await mock(...args);
        if (options.phase2Failure === 'open-stream') {
          response.process.stdout = stream;
        }
        if (options.phase2Failure === 'unknown-exit') {
          Object.assign(response.process, { exitCode: null, signalCode: null });
        }
        return response;
      }

      throw new Error(`Unexpected xcodebuild action: ${cmd.join(' ')}`);
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

  return {
    calls,
    stream,
    root,
    startObservingDeviceCalls: () => {
      observingTestAdmission = true;
    },
    getFirstDeviceCallSnapshotStatus: () => firstDeviceCallSnapshotStatus,
  };
}

describe('Managed test_sim integration and lifecycle gate', () => {
  it('exposes explicit project, workspace, scheme, configuration, DD, prefer, UUID, credentials, testRunnerEnv, progress on schema', () => {
    const schema = managedToolSchema(moduleId, testSimSchema);
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
    expect(schema).toHaveProperty('testRunnerEnv');
    expect(schema).toHaveProperty('progress');

    const mcpSchema = managedToolSchema(moduleId, testSimMcpSchema);
    expect(mcpSchema).toHaveProperty('testRunnerEnv');
    expect(mcpSchema).toHaveProperty('progress');
  });

  it('parses wire array testRunnerEnv in managedToolSchema(mcpSchema), requires credentials and scheme/UUID, and forwards to both phases', async () => {
    setupSyncExtractSentinels();
    const capturedEnvs: Record<string, string | undefined>[] = [];
    const { calls, root } = commands({ capturedEnvs });
    const ctx = context();

    const managedMcpSchema = z.object(managedToolSchema(moduleId, testSimMcpSchema));

    // 1. Successful parse of wire array format with workspacePath, extraArgs: [], preferXcodebuild: true
    const parsed = managedMcpSchema.parse({
      ...credentials(),
      workspacePath: join(root, 'TestApp.xcworkspace'),
      scheme: 'TestApp',
      extraArgs: [],
      preferXcodebuild: true,
      testRunnerEnv: [{ key: 'CUSTOM_VAR', value: 'custom_val' }],
    });

    // 2. Schema enforces required credentials and scheme/simulatorId
    expect(() =>
      managedMcpSchema.parse({
        operationToken: lease.token,
        operationSessionId: lease.sessionId,
        workspacePath: join(root, 'TestApp.xcworkspace'),
        scheme: 'TestApp',
      }),
    ).toThrow(); // missing operationRequestId, simulatorId

    expect(() =>
      managedMcpSchema.parse({
        ...credentials(),
        workspacePath: join(root, 'TestApp.xcworkspace'),
        // missing scheme
      }),
    ).toThrow();

    expect(() =>
      managedMcpSchema.parse({
        ...credentials(),
        workspacePath: join(root, 'TestApp.xcworkspace'),
        scheme: 'TestApp',
        simulatorId: 'not-a-uuid',
      }),
    ).toThrow();

    // 3. Pass wire array input directly to tool handler
    await testTool(parsed, ctx);

    expect(ctx.structuredOutput?.result.didError).toBe(false);
    expect(ctx.structuredOutput?.result).toMatchObject({
      summary: { status: 'SUCCEEDED' },
    });

    // 4. Verify workspace and destination args on xcodebuild calls
    const buildCall = calls.find((c) => c[0] === 'xcodebuild' && c.includes('build-for-testing'));
    expect(buildCall).toBeDefined();
    expect(buildCall).toContain('-workspace');
    expect(buildCall).toContain(join(root, 'TestApp.xcworkspace'));
    expect(buildCall).toContain('-destination');
    expect(buildCall).toContain(`platform=iOS Simulator,id=${lease.simulatorId.toUpperCase()}`);

    const testCall = calls.find(
      (c) => c[0] === 'xcodebuild' && c.includes('test-without-building'),
    );
    expect(testCall).toBeDefined();
    expect(testCall).toContain('-destination');
    expect(testCall).toContain(`platform=iOS Simulator,id=${lease.simulatorId.toUpperCase()}`);

    // 5. Verify TEST_RUNNER_ env forwarded in both Phase 1 and Phase 2 commands
    expect(capturedEnvs.length).toBeGreaterThanOrEqual(2);
    expect(capturedEnvs[0]?.TEST_RUNNER_CUSTOM_VAR).toBe('custom_val');
    expect(capturedEnvs[1]?.TEST_RUNNER_CUSTOM_VAR).toBe('custom_val');
  });

  it('rejects credentials missing, wrong token, wrong session, foreign UUID, and simulatorName before device executor', async () => {
    const { calls, root } = commands();
    const baseParams = {
      projectPath: join(root, 'TestApp.xcodeproj'),
      scheme: 'TestApp',
    };

    // Missing credentials
    await expect(
      testTool({ ...baseParams, simulatorId: lease.simulatorId }, context()),
    ).rejects.toThrow('credentials');

    // Wrong token
    await expect(
      testTool({ ...baseParams, ...credentials(), operationToken: randomUUID() }, context()),
    ).rejects.toThrow();

    // Wrong session
    await expect(
      testTool({ ...baseParams, ...credentials(), operationSessionId: randomUUID() }, context()),
    ).rejects.toThrow();

    // Foreign UUID
    await expect(
      testTool({ ...baseParams, ...credentials(), simulatorId: randomUUID() }, context()),
    ).rejects.toThrow();

    // simulatorName provided
    await expect(
      testTool(
        {
          ...baseParams,
          operationRequestId: lease.requestId,
          operationToken: lease.token,
          operationSessionId: lease.sessionId,
          simulatorName: 'iPhone 16 Pro',
        },
        context(),
      ),
    ).rejects.toThrow('without a name');

    expect(calls).toHaveLength(0);
    expect((await manager.getStatus(lease.requestId)).activities).toHaveLength(0);
  });

  it('rejects source missing, conflicting, valid+blank, session defaults when raw missing, and prepared paths with 0 commands', async () => {
    const { calls, root } = commands();
    const creds = credentials();

    // 1. Missing source (neither projectPath nor workspacePath)
    await expect(testTool({ ...creds, scheme: 'TestApp' }, context())).rejects.toThrow(
      'exactly one of projectPath or workspacePath',
    );

    // 2. Conflicting sources (both projectPath and workspacePath)
    await expect(
      testTool(
        {
          ...creds,
          projectPath: join(root, 'TestApp.xcodeproj'),
          workspacePath: join(root, 'TestApp.xcworkspace'),
          scheme: 'TestApp',
        },
        context(),
      ),
    ).rejects.toThrow('exactly one of projectPath or workspacePath');

    // 3. Valid project + blank workspace
    await expect(
      testTool(
        {
          ...creds,
          projectPath: join(root, 'TestApp.xcodeproj'),
          workspacePath: '   ',
          scheme: 'TestApp',
        },
        context(),
      ),
    ).rejects.toThrow('blank workspacePath');

    // 4. Valid workspace + blank project
    await expect(
      testTool(
        {
          ...creds,
          workspacePath: join(root, 'TestApp.xcworkspace'),
          projectPath: '   ',
          scheme: 'TestApp',
        },
        context(),
      ),
    ).rejects.toThrow('blank projectPath');

    // 5. Blank scheme
    await expect(
      testTool(
        { ...creds, projectPath: join(root, 'TestApp.xcodeproj'), scheme: '   ' },
        context(),
      ),
    ).rejects.toThrow('non-empty scheme');

    // 6. Blank simulatorId
    await expect(
      testTool(
        {
          ...creds,
          projectPath: join(root, 'TestApp.xcodeproj'),
          scheme: 'TestApp',
          simulatorId: '   ',
        },
        context(),
      ),
    ).rejects.toThrow('explicit simulatorId');

    // 7. Session defaults configured with source, scheme, simulatorId, but raw args omitted
    sessionStore.setDefaults({
      scheme: 'DefaultScheme',
      projectPath: join(root, 'TestApp.xcodeproj'),
      simulatorId: lease.simulatorId,
    });

    // Raw missing source even when in session defaults
    await expect(testTool({ ...creds, scheme: 'TestApp' }, context())).rejects.toThrow(
      'exactly one of projectPath or workspacePath',
    );

    // Raw missing scheme even when in session defaults
    await expect(
      testTool({ ...creds, projectPath: join(root, 'TestApp.xcodeproj') }, context()),
    ).rejects.toThrow('non-empty scheme');

    // Raw missing simulatorId even when in session defaults
    await expect(
      testTool(
        {
          projectPath: join(root, 'TestApp.xcodeproj'),
          scheme: 'TestApp',
          operationRequestId: lease.requestId,
          operationToken: lease.token,
          operationSessionId: lease.sessionId,
        },
        context(),
      ),
    ).rejects.toThrow();

    sessionStore.clear();

    // 8. Prepared test paths rejected on raw args
    const base = defaultTestParams(root);
    await expect(
      testTool({ ...base, testProductsPath: '/tmp/fixture.xctestproducts' }, context()),
    ).rejects.toThrow('prepared test artifacts');
    await expect(
      testTool({ ...base, xctestrunPath: '/tmp/fixture.xctestrun' }, context()),
    ).rejects.toThrow('prepared test artifacts');

    // 9. Forbidden buildForTesting
    await expect(testTool({ ...base, buildForTesting: true }, context())).rejects.toThrow(
      'buildForTesting',
    );

    expect(calls).toHaveLength(0);
    expect((await manager.getStatus(lease.requestId)).activities).toHaveLength(0);
  });

  it('rejects non-empty extraArgs and preferXcodebuild=false (explicit and session defaults) with 0 commands', async () => {
    const { calls, root } = commands();
    const base = defaultTestParams(root);

    // Direct non-empty extraArgs
    await expect(testTool({ ...base, extraArgs: ['-verbose'] }, context())).rejects.toThrow(
      'extraArgs',
    );

    // Inherited non-empty extraArgs from session defaults
    sessionStore.setDefaults({ extraArgs: ['-inherited'] });
    await expect(testTool(base, context())).rejects.toThrow('extraArgs');
    sessionStore.clear();

    // Direct preferXcodebuild = false
    await expect(testTool({ ...base, preferXcodebuild: false }, context())).rejects.toThrow(
      'preferXcodebuild=false',
    );

    // Inherited preferXcodebuild = false from session defaults
    sessionStore.setDefaults({ preferXcodebuild: false });
    await expect(testTool(base, context())).rejects.toThrow('preferXcodebuild=false');
    sessionStore.clear();

    expect(calls).toHaveLength(0);
    expect((await manager.getStatus(lease.requestId)).activities).toHaveLength(0);
  });

  it.each([64, 65, 66] as const)(
    'Phase 1 confirmed exit %i (compile failure): does not invoke shutdown or xcresult, stays active+activity0, released on explicit end',
    async (phase1ExitCode) => {
      setupSyncExtractSentinels();
      const { calls, root } = commands({
        phase1Failure: 'exit',
        phase1ExitCode,
      });
      const ctx = context();

      await testTool(defaultTestParams(root), ctx);

      expect(ctx.structuredOutput?.result.didError).toBe(true);
      expect(ctx.structuredOutput?.result).toMatchObject({
        summary: { status: 'FAILED' },
      });

      // Phase 1 failed: No Phase 2, no xcresulttool, no simctl shutdown
      expect(calls.some((c) => c.includes('test-without-building'))).toBe(false);
      expect(calls.some((c) => c[0] === 'xcrun' && c.includes('tests'))).toBe(false);
      expect(calls.some((c) => c[0] === 'xcrun' && c.includes('shutdown'))).toBe(false);

      // Active state with 0 remaining activities
      const status = await manager.getStatus(lease.requestId);
      expect(status.state).toBe('active');
      expect(status.activities).toHaveLength(0);

      // Explicit end releases lease cleanly
      expect((await manager.end(lease)).state).toBe('released');
    },
  );

  it.each([
    [0, false, 'SUCCEEDED'],
    [65, true, 'FAILED'],
  ])(
    'Phase 2 exit %i: executes shutdown and post-list, staying active+activity0, released on end',
    async (exitCode, didError, statusString) => {
      setupSyncExtractSentinels();
      const { calls, root } = commands({
        phase2Failure: exitCode === 0 ? undefined : 'exit',
        phase2ExitCode: exitCode,
      });
      const ctx = context();

      await testTool(defaultTestParams(root), ctx);

      expect(ctx.structuredOutput?.result.didError).toBe(didError);
      expect(ctx.structuredOutput?.result).toMatchObject({
        summary: { status: statusString },
      });

      // Both execute shutdown and post-list commands with complete argv
      const shutdownCall = calls.find(
        (c) => c[0] === 'xcrun' && c[1] === 'simctl' && c[2] === 'shutdown',
      );
      expect(shutdownCall).toEqual(['xcrun', 'simctl', 'shutdown', lease.simulatorId]);

      const shutdownIdx = calls.indexOf(shutdownCall!);
      expect(shutdownIdx).toBeGreaterThan(-1);

      const postListCall = calls
        .slice(shutdownIdx + 1)
        .find(
          (c) =>
            c[0] === 'xcrun' &&
            c[1] === 'simctl' &&
            c[2] === 'list' &&
            c[3] === 'devices' &&
            c[4] === '--json',
        );
      expect(postListCall).toEqual(['xcrun', 'simctl', 'list', 'devices', '--json']);

      const status = await manager.getStatus(lease.requestId);
      expect(status.state).toBe('active');
      expect(status.activities).toHaveLength(0);

      expect((await manager.end(lease)).state).toBe('released');
    },
  );

  it.each([
    ['phase 1 signal', { phase1Failure: 'signal' as const }],
    ['phase 2 confirmed nonzero exit', { phase2Failure: 'exit' as const, phase2ExitCode: 1 }],
    ['phase 2 signal', { phase2Failure: 'signal' as const }],
    ['phase 2 open stream', { phase2Failure: 'open-stream' as const }],
    ['phase 2 unknown exit', { phase2Failure: 'unknown-exit' as const }],
    ['shutdown nonzero exit', { shutdownFailure: 'exit' as const }],
    ['shutdown reject', { shutdownFailure: 'reject' as const }],
    ['post-catalog non-Shutdown', { postCatalogState: 'Booted' }],
    ['metadata reject', { metadataFailure: 'reject' as const }],
  ])('blocks lease and preserves unfinished activity on %s failure', async (_name, opts) => {
    setupSyncExtractSentinels();
    const { root } = commands(opts);

    const binding = await manager.getBinding((await manager.getStatus(lease.requestId)).generation);
    if (!binding) throw new Error('Missing fixture binding');
    const waiting = await manager.requestLease({
      requestId: randomUUID(),
      owner: { sessionId: randomUUID() },
      worktree: binding.worktree,
    });

    let thrownError: unknown;
    try {
      await testTool(defaultTestParams(root), context());
    } catch (error) {
      thrownError = error;
    }
    expect(thrownError).toBeDefined();
    expect((thrownError as Error).message).toContain('completion could not be confirmed');

    const status = await manager.getStatus(lease.requestId);
    expect(status.state).toBe('blocked');
    expect(status.activities).toHaveLength(1);
    expect((await manager.end(lease)).state).toBe('blocked');
    expect((await manager.poll(waiting)).state).toBe('waiting');
  });

  it.each([
    ['first metadata signal', 'signal-tests' as const, 1],
    ['second metadata signal', 'signal-summary' as const, 2],
  ])(
    'blocks lease and preserves unfinished activity on %s',
    async (_name, metadataFailure, expectedMetadataCalls) => {
      setupSyncExtractSentinels();
      const { calls, root } = commands({ metadataFailure });
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
      const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

      const binding = await manager.getBinding(
        (await manager.getStatus(lease.requestId)).generation,
      );
      if (!binding) throw new Error('Missing fixture binding');
      const waiting = await manager.requestLease({
        requestId: randomUUID(),
        owner: { sessionId: randomUUID() },
        worktree: binding.worktree,
      });

      let thrownError: unknown;
      try {
        await testTool(defaultTestParams(root), context());
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeDefined();
      expect((thrownError as Error).message).toContain('completion could not be confirmed');
      const gateError = thrownError as Error & { cause?: unknown };
      expect(gateError.cause).toBeInstanceOf(SimulatorTestUncertainError);
      const uncertainError = gateError.cause as Error & { cause?: unknown };
      expect(uncertainError.cause).toMatchObject({
        message:
          metadataFailure === 'signal-tests'
            ? 'xcresult test failure extraction interrupted by signal: SIGTERM'
            : 'xcresult test summary extraction interrupted by signal: SIGTERM',
      });

      const metadataCalls = calls.filter(
        (command) => command[0] === 'xcrun' && command[1] === 'xcresulttool',
      );
      expect(metadataCalls).toHaveLength(expectedMetadataCalls);
      expect(metadataCalls[0]).toEqual([
        'xcrun',
        'xcresulttool',
        'get',
        'test-results',
        'tests',
        '--path',
        expect.any(String),
      ]);
      if (metadataFailure === 'signal-summary') {
        expect(metadataCalls[1]).toEqual([
          'xcrun',
          'xcresulttool',
          'get',
          'test-results',
          'summary',
          '--path',
          expect.any(String),
          '--compact',
        ]);
      }
      expect(
        calls.some(
          (command) =>
            command[0] === 'xcrun' && command[1] === 'simctl' && command[2] === 'shutdown',
        ),
      ).toBe(false);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();

      const status = await manager.getStatus(lease.requestId);
      expect(status.state).toBe('blocked');
      expect(status.activities).toHaveLength(1);
      expect((await manager.end(lease)).state).toBe('blocked');
      expect((await manager.poll(waiting)).state).toBe('waiting');
    },
  );

  it('blocks lease and preserves cause when non-executor exception (emit callback throw) occurs during failure fragments without mocking async extractor', async () => {
    setupSyncExtractSentinels();
    const { calls, root } = commands({ phase2ExitCode: 65, xcresultFailures: true });
    const emitExplosion = new Error('Failure fragment emit explosion');

    const binding = await manager.getBinding((await manager.getStatus(lease.requestId)).generation);
    if (!binding) throw new Error('Missing fixture binding');
    const waiting = await manager.requestLease({
      requestId: randomUUID(),
      owner: { sessionId: randomUUID() },
      worktree: binding.worktree,
    });

    const ctx: ToolHandlerContext = {
      emit: (fragment) => {
        if (
          fragment.kind === 'test-result' &&
          (fragment as unknown as { fragment?: string }).fragment === 'test-failure'
        ) {
          throw emitExplosion;
        }
      },
      attach: () => {},
    };

    let capturedGateError: unknown;
    try {
      await testTool(defaultTestParams(root), ctx);
    } catch (error) {
      capturedGateError = error;
    }

    expect(capturedGateError).toBeDefined();
    const gateError = capturedGateError as Error & { cause?: unknown };
    expect(gateError.cause).toBeInstanceOf(SimulatorTestUncertainError);
    expect((gateError.cause as Error & { cause?: unknown }).cause).toBe(emitExplosion);

    const status = await manager.getStatus(lease.requestId);
    expect(status.state).toBe('blocked');
    expect(status.activities).toHaveLength(1);
    expect((await manager.end(lease)).state).toBe('blocked');
    expect((await manager.poll(waiting)).state).toBe('waiting');

    // Subsequent shutdown was not called
    expect(calls.some((c) => c[0] === 'xcrun' && c[1] === 'simctl' && c[2] === 'shutdown')).toBe(
      false,
    );
  });

  it('generic phase 1 emit error before phase 2 finishes activity without blocking lease, allowing waiting session to be granted', async () => {
    setupSyncExtractSentinels();
    const { calls, root } = commands();
    const phase1Explosion = new Error('Phase 1 discovery emit explosion');

    const binding = await manager.getBinding((await manager.getStatus(lease.requestId)).generation);
    if (!binding) throw new Error('Missing fixture binding');
    const waiting = await manager.requestLease({
      requestId: randomUUID(),
      owner: { sessionId: randomUUID() },
      worktree: binding.worktree,
    });

    const ctx: ToolHandlerContext = {
      emit: (fragment) => {
        if (
          fragment.kind === 'test-result' &&
          (fragment as unknown as { fragment?: string }).fragment === 'build-stage'
        ) {
          throw phase1Explosion;
        }
      },
      attach: () => {},
    };

    let capturedPhase1Error: unknown;
    try {
      await testTool(defaultTestParams(root), ctx);
    } catch (error) {
      capturedPhase1Error = error;
    }

    expect(capturedPhase1Error).toBe(phase1Explosion);

    // Active state with 0 remaining activities (finishActivity called)
    const status = await manager.getStatus(lease.requestId);
    expect(status.state).toBe('active');
    expect(status.activities).toHaveLength(0);

    // Explicit end releases lease and grants waiting session
    expect((await manager.end(lease)).state).toBe('released');
    expect((await manager.poll(waiting)).state).toBe('active');

    expect(calls.some((c) => c[0] === 'xcrun' && c[1] === 'simctl' && c[2] === 'shutdown')).toBe(
      false,
    );
  });

  it('race: holds closing during shutdown and post-list, waiting session granted upon verified shutdown', async () => {
    setupSyncExtractSentinels();
    const enteredShutdown = createDeferred<void>();
    const releaseShutdown = createDeferred<void>();
    const enteredPostList = createDeferred<void>();
    const releasePostList = createDeferred<void>();

    const { root } = commands({
      onShutdown: async () => {
        enteredShutdown.resolve();
        await releaseShutdown.promise;
      },
      onPostList: async () => {
        enteredPostList.resolve();
        await releasePostList.promise;
      },
    });

    const binding = await manager.getBinding((await manager.getStatus(lease.requestId)).generation);
    if (!binding) throw new Error('Missing fixture binding');
    const waiting = await manager.requestLease({
      requestId: randomUUID(),
      owner: { sessionId: randomUUID() },
      worktree: binding.worktree,
    });

    const run = testTool(defaultTestParams(root), context());

    try {
      // 1. Pause inside shutdown
      await enteredShutdown.promise;
      expect((await manager.end(lease)).state).toBe('closing');
      expect((await manager.poll(waiting)).state).toBe('waiting');

      // A new call to the closing lease is rejected
      await expect(testTool(defaultTestParams(root), context())).rejects.toThrow();

      releaseShutdown.resolve();

      // 2. Pause inside post-list verification
      await enteredPostList.promise;
      expect((await manager.getStatus(lease.requestId)).state).toBe('closing');
      expect((await manager.poll(waiting)).state).toBe('waiting');

      releasePostList.resolve();

      // 3. Complete run
      await run;

      expect((await manager.getStatus(lease.requestId)).state).toBe('released');
      expect((await manager.poll(waiting)).state).toBe('active');
    } finally {
      releaseShutdown.resolve();
      releasePostList.resolve();
      await run.catch(() => {});
    }
  });

  it('race: when post-list verification fails, lease becomes blocked and waiting session is not granted', async () => {
    setupSyncExtractSentinels();
    const enteredPostList = createDeferred<void>();
    const releasePostList = createDeferred<void>();

    const { root } = commands({
      postCatalogState: 'Booted', // verification failure
      onPostList: async () => {
        enteredPostList.resolve();
        await releasePostList.promise;
      },
    });

    const binding = await manager.getBinding((await manager.getStatus(lease.requestId)).generation);
    if (!binding) throw new Error('Missing fixture binding');
    const waiting = await manager.requestLease({
      requestId: randomUUID(),
      owner: { sessionId: randomUUID() },
      worktree: binding.worktree,
    });

    const run = testTool(defaultTestParams(root), context());

    try {
      await enteredPostList.promise;
      expect((await manager.end(lease)).state).toBe('closing');
      expect((await manager.poll(waiting)).state).toBe('waiting');

      releasePostList.resolve();

      await expect(run).rejects.toThrow('completion could not be confirmed');

      expect((await manager.getStatus(lease.requestId)).state).toBe('blocked');
      expect((await manager.poll(waiting)).state).toBe('waiting');
    } finally {
      releasePostList.resolve();
      await run.catch(() => {});
    }
  });

  it('invalidates previous UI snapshot on admission (verified at first device call) and suppresses next-step metadata', async () => {
    vi.spyOn(defaultAxeHelpers, 'getAxePath').mockReturnValue('/fixture/axe');
    vi.spyOn(defaultAxeHelpers, 'getBundledAxeEnvironment').mockReturnValue({});
    setupSyncExtractSentinels();

    const { root, startObservingDeviceCalls, getFirstDeviceCallSnapshotStatus } = commands();

    // 1. Establish snapshot provenance via real managed snapshot_ui
    const snapshotCtx = context();
    const snapshotTool = wrapManagedTool('mcp/tools/ui-automation/snapshot_ui', (args, ctx) => {
      if (!ctx) throw new Error('Missing fixture context');
      return snapshotHandler(args, ctx);
    });
    await snapshotTool(credentials(), snapshotCtx);

    expect(getRuntimeSnapshotLookup(lease.simulatorId).status).toBe('available');

    // 2. Start observing device calls specifically for test_sim admission
    startObservingDeviceCalls();

    // 3. Invoke test_sim
    const ctx = context();
    await testTool(defaultTestParams(root), ctx);

    // Snapshot was invalidated upon admission (observed at first device executor call)
    expect(getFirstDeviceCallSnapshotStatus()).toBe('missing');
    expect(getRuntimeSnapshotLookup(lease.simulatorId).status).toBe('missing');

    // Schema version 3 preserved
    expect(ctx.structuredOutput?.schemaVersion).toBe('3');
    expect(ctx.structuredOutput?.result.kind).toBe('test-result');

    // Next-step metadata suppressed
    expect(ctx.nextSteps).toEqual([]);
    expect(ctx.nextStepParams).toBeUndefined();
    expect(ctx.nextStepConditionKeys).toBeUndefined();
  });
});
