import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createTestExecutor, type SharedTestExecutorParams } from '../../utils/test-common.ts';
import { XcodePlatform } from '../../utils/xcode.ts';
import { CommandSupervision, supervisedExecutor } from '../execution.ts';
import { SimulatorTestUncertainError } from '../test-execution.ts';
import { createMockExecutor, type CommandExecutor } from '../../test-utils/mock-executors.ts';
import type { CommandResponse } from '../../utils/CommandExecutor.ts';
import * as logCaptureModule from '../../utils/xcodebuild-log-capture.ts';
import * as logPathsModule from '../../utils/log-paths.ts';
import * as testProductsModule from '../../utils/test-products-path.ts';
import * as resultBundleModule from '../../utils/result-bundle-path.ts';
import * as xcresultModule from '../../utils/xcresult-test-failures.ts';
import type { ToolHandlerContext } from '../../rendering/types.ts';
import { createStreamingExecutionContext } from '../../utils/xcodebuild-domain-results.ts';

describe('createTestExecutor lifecycle and supervision contract', () => {
  let tempDir: string;
  let logsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'test-execution-lifecycle-'));
    logsDir = join(tempDir, 'logs');
    logPathsModule.setXcodeBuildMCPAppDirOverrideForTests(tempDir);
    logCaptureModule.setXcodebuildLogDirOverrideForTests(logsDir);

    // Mock xcresult extraction to avoid real xcresulttool execFileSync
    vi.spyOn(xcresultModule, 'extractTestFailuresFromXcresult').mockReturnValue([]);
    vi.spyOn(xcresultModule, 'extractTestSummaryCountsFromXcresult').mockReturnValue({
      passed: 1,
      failed: 0,
      skipped: 0,
    });
  });

  afterEach(async () => {
    logPathsModule.setXcodeBuildMCPAppDirOverrideForTests(null);
    logCaptureModule.setXcodebuildLogDirOverrideForTests(null);
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  const createContext = () => {
    const rawCtx: ToolHandlerContext = {
      emit: () => {},
      attach: () => {},
    };
    const streamingCtx = createStreamingExecutionContext(rawCtx);
    return { rawCtx, streamingCtx };
  };

  const defaultParams: SharedTestExecutorParams = {
    projectPath: '/tmp/test/App.xcodeproj',
    scheme: 'AppScheme',
    simulatorId: '65FAA1DC-6DC9-456D-A88E-3CF5A516F95B',
    platform: XcodePlatform.iOSSimulator,
  };

  function setupLogCaptureSpy() {
    let captureClosed = false;
    let closeCount = 0;
    let capturedLogPath: string | null = null;
    const origCreate = logCaptureModule.createLogCapture;
    vi.spyOn(logCaptureModule, 'createLogCapture').mockImplementation((toolName) => {
      const cap = origCreate(toolName);
      capturedLogPath = cap.path;
      const origClose = cap.close.bind(cap);
      cap.close = () => {
        closeCount++;
        captureClosed = true;
        origClose();
      };
      return cap;
    });
    return {
      isClosed: () => captureClosed,
      get closeCount() {
        return closeCount;
      },
      getLogPath: () => capturedLogPath,
    };
  }

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

  async function mockCommandResponse(
    options: {
      success?: boolean;
      exitCode?: number;
      output?: string;
      error?: string;
    } = {},
  ): Promise<CommandResponse> {
    return createMockExecutor(options)(['mock']);
  }

  function makeCatalogJson(
    devices:
      | Array<{ udid: string; isAvailable: boolean; state: string }>
      | Record<string, Array<{ udid: string; isAvailable: boolean; state: string }>>,
  ): string {
    if (Array.isArray(devices)) {
      return JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-0': devices,
        },
      });
    }
    return JSON.stringify({ devices });
  }

  function createSimctlLifecycleHandler(simulatorId: string) {
    let simState = 'Booted';
    return async (command: readonly string[]): Promise<CommandResponse | null> => {
      if (command[0] !== 'xcrun' || command[1] !== 'simctl') {
        return null;
      }
      if (
        command[2] === 'list' &&
        command[3] === 'devices' &&
        command[4] === '--json' &&
        command.length === 5
      ) {
        return mockCommandResponse({
          success: true,
          exitCode: 0,
          output: makeCatalogJson([
            {
              udid: simulatorId,
              isAvailable: true,
              state: simState,
            },
          ]),
        });
      }
      if (command[2] === 'shutdown' && command[3] === simulatorId && command.length === 4) {
        simState = 'Shutdown';
        return mockCommandResponse({
          success: true,
          exitCode: 0,
          output: '',
        });
      }
      throw new Error(`Unexpected simctl command: ${command.join(' ')}`);
    };
  }

  it('Phase 1 reject: closes pipeline log file descriptor and suppresses completion marker in supervised mode', async () => {
    const logSpy = setupLogCaptureSpy();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    let capturedProductsPath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Phase 1 building...\n');
        throw new Error('Phase 1 executor rejected');
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(supervision.run(() => execute(defaultParams, streamingCtx))).rejects.toThrow(
      'Phase 1 executor rejected',
    );

    expect(logSpy.closeCount).toBe(1);
    expect(markProductsSpy).not.toHaveBeenCalled();

    // Actual filesystem assertion: directory exists, marker does not exist
    expect(capturedProductsPath).toBeDefined();
    await expect(stat(capturedProductsPath!)).resolves.toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Phase 1 unknown exit (null/null): closes pipeline log descriptor and does not mark products completed', async () => {
    const logSpy = setupLogCaptureSpy();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    let capturedProductsPath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Phase 1 building...\n');
        const response = await mockCommandResponse({ success: true, output: 'ok' });
        Object.assign(response.process, { exitCode: null, signalCode: null });
        return response;
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(supervision.run(() => execute(defaultParams, streamingCtx))).rejects.toThrow(
      'Managed command completion is uncertain',
    );

    expect(logSpy.closeCount).toBe(1);
    expect(markProductsSpy).not.toHaveBeenCalled();

    expect(capturedProductsPath).toBeDefined();
    await expect(stat(capturedProductsPath!)).resolves.toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Phase 1 unknown exit (undefined/undefined): low-level wrapper rejects nonnumeric completion', async () => {
    const logSpy = setupLogCaptureSpy();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const capturedCommands: string[][] = [];

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      capturedCommands.push([...command]);
      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Unknown completion\n');
        const response = await mockCommandResponse({
          success: false,
          output: 'Unknown completion',
        });
        Object.assign(response.process, { exitCode: undefined, signalCode: null });
        response.exitCode = undefined;
        return response;
      }
      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const execute = createTestExecutor(mockExecutor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    let caughtError: unknown;
    try {
      await supervision.run(() => execute(defaultParams, streamingCtx));
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(SimulatorTestUncertainError);
    expect((caughtError as Error).message).toContain(
      'Unexpected xcodebuild test exit code: undefined',
    );
    expect(logSpy.closeCount).toBe(1);
    expect(markProductsSpy).not.toHaveBeenCalled();
    expect(capturedCommands).toHaveLength(1);
  });

  it('Phase 1 open stream: closes pipeline log descriptor and does not mark products completed', async () => {
    const logSpy = setupLogCaptureSpy();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const stream = new PassThrough();
    let capturedProductsPath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Phase 1 building...\n');
        const response = await mockCommandResponse({ success: true, exitCode: 0, output: 'ok' });
        Object.assign(response.process, { stdout: stream });
        return response;
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    try {
      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      await expect(supervision.run(() => execute(defaultParams, streamingCtx))).rejects.toThrow(
        'Managed command completion is uncertain',
      );

      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).not.toHaveBeenCalled();

      expect(capturedProductsPath).toBeDefined();
      await expect(stat(capturedProductsPath!)).resolves.toBeDefined();
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      stream.destroy();
    }
  });

  it('Phase 1 build failure (exit 65): does not proceed to Phase 2, returns domain failure, marks products completed, closes log', async () => {
    const logSpy = setupLogCaptureSpy();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    let phase2Invoked = false;
    let capturedProductsPath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Phase 1 build failed...\n');
        return mockCommandResponse({
          success: false,
          exitCode: 65,
          error: 'Build failed',
          output: 'Compile error',
        });
      }
      if (command.includes('test-without-building')) {
        phase2Invoked = true;
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    const result = await supervision.run(() => execute(defaultParams, streamingCtx));

    expect(phase2Invoked).toBe(false);
    expect(result.didError).toBe(true);
    expect(result.summary.status).toBe('FAILED');
    expect(markProductsSpy).toHaveBeenCalled();
    expect(logSpy.closeCount).toBe(1);

    expect(capturedProductsPath).toBeDefined();
    await expect(stat(capturedProductsPath!)).resolves.toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).resolves.toBeUndefined();
  });

  it('Phase 2 reject: closes pipeline log descriptor and does not mark products or resultBundle completed in supervised mode', async () => {
    const logSpy = setupLogCaptureSpy();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Phase 1 succeeded\n');
        return mockCommandResponse({
          success: true,
          exitCode: 0,
          output: 'Phase 1 succeeded',
        });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Phase 2 running...\n');
        throw new Error('Phase 2 executor rejected');
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(supervision.run(() => execute(defaultParams, streamingCtx))).rejects.toThrow(
      'Phase 2 executor rejected',
    );

    expect(logSpy.closeCount).toBe(1);
    expect(markProductsSpy).not.toHaveBeenCalled();
    expect(markResultSpy).not.toHaveBeenCalled();

    expect(capturedProductsPath).toBeDefined();
    expect(capturedResultBundlePath).toBeDefined();
    await expect(stat(capturedProductsPath!)).resolves.toBeDefined();
    await expect(stat(capturedResultBundlePath!)).resolves.toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Phase 2 unknown exit (null/null): closes pipeline log descriptor and suppresses completion markers in supervised mode', async () => {
    const logSpy = setupLogCaptureSpy();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Phase 1 succeeded\n');
        return mockCommandResponse({
          success: true,
          exitCode: 0,
          output: 'Phase 1 succeeded',
        });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Phase 2 running...\n');
        const response = await mockCommandResponse({ success: true, output: 'Test succeeded' });
        Object.assign(response.process, { exitCode: null, signalCode: null });
        return response;
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(supervision.run(() => execute(defaultParams, streamingCtx))).rejects.toThrow(
      'Managed command completion is uncertain',
    );

    expect(logSpy.closeCount).toBe(1);
    expect(markProductsSpy).not.toHaveBeenCalled();
    expect(markResultSpy).not.toHaveBeenCalled();

    expect(capturedProductsPath).toBeDefined();
    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Phase 2 open stream: closes pipeline log descriptor and suppresses completion markers in supervised mode', async () => {
    const logSpy = setupLogCaptureSpy();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    const stream = new PassThrough();
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Phase 1 succeeded\n');
        return mockCommandResponse({
          success: true,
          exitCode: 0,
          output: 'Phase 1 succeeded',
        });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Phase 2 running...\n');
        const response = await mockCommandResponse({
          success: true,
          exitCode: 0,
          output: 'Test succeeded',
        });
        Object.assign(response.process, { stdout: stream });
        return response;
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    try {
      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      await expect(supervision.run(() => execute(defaultParams, streamingCtx))).rejects.toThrow(
        'Managed command completion is uncertain',
      );

      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();

      expect(capturedProductsPath).toBeDefined();
      expect(capturedResultBundlePath).toBeDefined();
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      stream.destroy();
    }
  });

  it('Phase 2 finalize emit throw integration: propagates original error object and guarantees closeCount is 1 despite re-entrant catch finalize', async () => {
    const logSpy = setupLogCaptureSpy();
    const explosiveError = new Error('Explosive emit in finalize flush');

    let phase2Finished = false;
    const simctlHandler = createSimctlLifecycleHandler(defaultParams.simulatorId!);

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      const simctlRes = await simctlHandler(command);
      if (simctlRes) {
        return simctlRes;
      }
      if (command[0] === 'xcrun') {
        if (command.includes('tests')) {
          return mockCommandResponse({
            success: true,
            exitCode: 0,
            output: JSON.stringify({ testNodes: [] }),
          });
        }
        if (command.includes('summary')) {
          return mockCommandResponse({
            success: true,
            exitCode: 0,
            output: JSON.stringify({
              totalTestCount: 1,
              passedTests: 1,
              failedTests: 0,
              skippedTests: 0,
            }),
          });
        }
        throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Phase 1 succeeded\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'ok' });
      }
      if (command.includes('test-without-building')) {
        // Feed line without newline so it remains buffered until parser.flush() in finalize
        opts?.onStdout?.("Test Case '-[Suite testA]' passed (0.001 seconds)");
        const res = await mockCommandResponse({ success: true, exitCode: 0, output: 'ok' });
        phase2Finished = true;
        return res;
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const rawCtx: ToolHandlerContext = {
      emit: () => {
        if (phase2Finished) {
          throw explosiveError;
        }
      },
      attach: () => {},
    };
    const streamingCtx = createStreamingExecutionContext(rawCtx);

    let caughtError: unknown;
    try {
      await supervision.run(() => execute(defaultParams, streamingCtx));
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBe(explosiveError);
    expect(logSpy.closeCount).toBe(1);
  });

  it('Prepared Phase 2 normal execution: marks resultBundle completed, closes log, finalize count is 1', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedResultBundlePath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] === 'xcrun') {
        if (command.includes('tests')) {
          return mockCommandResponse({
            success: true,
            exitCode: 0,
            output: JSON.stringify({ testNodes: [] }),
          });
        }
        if (command.includes('summary')) {
          return mockCommandResponse({
            success: true,
            exitCode: 0,
            output: JSON.stringify({
              totalTestCount: 1,
              passedTests: 1,
              failedTests: 0,
              skippedTests: 0,
            }),
          });
        }
        throw new Error(`Unexpected xcrun command: ${command.join(' ')}`);
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Prepared test running...\n');
        return mockCommandResponse({
          success: true,
          exitCode: 0,
          output: 'Prepared test ok',
        });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    const result = await supervision.run(() =>
      execute(
        {
          ...defaultParams,
          testProductsPath: join(tempDir, 'fixture.xctestproducts'),
        },
        streamingCtx,
      ),
    );

    expect(result.didError).toBe(false);
    expect(result.summary.status).toBe('SUCCEEDED');
    expect(markResultSpy).toHaveBeenCalled();
    expect(logSpy.closeCount).toBe(1);

    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).resolves.toBeUndefined();
  });

  it('Prepared Phase 2 reject: closes pipeline log descriptor and suppresses resultBundle completion marker in supervised mode', async () => {
    const logSpy = setupLogCaptureSpy();
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedResultBundlePath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Prepared test running...\n');
        throw new Error('Prepared test rejected');
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(
      supervision.run(() =>
        execute(
          {
            ...defaultParams,
            testProductsPath: join(tempDir, 'fixture.xctestproducts'),
          },
          streamingCtx,
        ),
      ),
    ).rejects.toThrow('Prepared test rejected');

    expect(logSpy.closeCount).toBe(1);
    expect(markResultSpy).not.toHaveBeenCalled();

    expect(capturedResultBundlePath).toBeDefined();
    await expect(stat(capturedResultBundlePath!)).resolves.toBeDefined();
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Prepared Phase 2 unknown exit (null/null): closes pipeline log descriptor and suppresses resultBundle completion marker', async () => {
    const logSpy = setupLogCaptureSpy();
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedResultBundlePath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Prepared test running...\n');
        const response = await mockCommandResponse({
          success: true,
          output: 'Prepared test ok',
        });
        Object.assign(response.process, { exitCode: null, signalCode: null });
        return response;
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(
      supervision.run(() =>
        execute(
          {
            ...defaultParams,
            testProductsPath: join(tempDir, 'fixture.xctestproducts'),
          },
          streamingCtx,
        ),
      ),
    ).rejects.toThrow('Managed command completion is uncertain');

    expect(logSpy.closeCount).toBe(1);
    expect(markResultSpy).not.toHaveBeenCalled();

    expect(capturedResultBundlePath).toBeDefined();
    await expect(stat(capturedResultBundlePath!)).resolves.toBeDefined();
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Prepared Phase 2 open stream: closes pipeline log descriptor and suppresses resultBundle completion marker', async () => {
    const logSpy = setupLogCaptureSpy();
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    const stream = new PassThrough();
    let capturedResultBundlePath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Prepared test running...\n');
        const response = await mockCommandResponse({
          success: true,
          exitCode: 0,
          output: 'Prepared test ok',
        });
        Object.assign(response.process, { stdout: stream });
        return response;
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    try {
      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              testProductsPath: join(tempDir, 'fixture.xctestproducts'),
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow('Managed command completion is uncertain');

      expect(logSpy.closeCount).toBe(1);
      expect(markResultSpy).not.toHaveBeenCalled();

      expect(capturedResultBundlePath).toBeDefined();
      await expect(stat(capturedResultBundlePath!)).resolves.toBeDefined();
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      stream.destroy();
    }
  });

  it('Normal successful execution: marks artifacts completed, closes log, finalize count is 1', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;
    const simctlHandler = createSimctlLifecycleHandler(defaultParams.simulatorId!);

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      const simctlRes = await simctlHandler(command);
      if (simctlRes) {
        return simctlRes;
      }
      if (command[0] === 'xcrun') {
        if (command.includes('tests')) {
          return mockCommandResponse({
            success: true,
            exitCode: 0,
            output: JSON.stringify({ testNodes: [] }),
          });
        }
        if (command.includes('summary')) {
          return mockCommandResponse({
            success: true,
            exitCode: 0,
            output: JSON.stringify({
              totalTestCount: 1,
              passedTests: 1,
              failedTests: 0,
              skippedTests: 0,
            }),
          });
        }
        throw new Error(`Unexpected xcrun command: ${command.join(' ')}`);
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Build succeeded\n');
        return mockCommandResponse({
          success: true,
          exitCode: 0,
          output: 'Build succeeded',
        });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Test succeeded\n');
        return mockCommandResponse({
          success: true,
          exitCode: 0,
          output: 'Test succeeded',
        });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    const result = await supervision.run(() => execute(defaultParams, streamingCtx));

    expect(result.didError).toBe(false);
    expect(result.summary.status).toBe('SUCCEEDED');
    expect(markProductsSpy).toHaveBeenCalled();
    expect(markResultSpy).toHaveBeenCalled();
    expect(logSpy.closeCount).toBe(1);

    expect(capturedProductsPath).toBeDefined();
    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).resolves.toBeUndefined();
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).resolves.toBeUndefined();
  });

  it('Pre-execution artifact path creation error: closes log file descriptor and propagates original error', async () => {
    const logSpy = setupLogCaptureSpy();
    vi.spyOn(testProductsModule, 'createDefaultTestProductsPath').mockImplementation(() => {
      throw new Error('Disk failure creating test products path');
    });

    const mockExecutor: CommandExecutor = vi.fn(async () => {
      throw new Error('Should not execute any command');
    });

    const execute = createTestExecutor(mockExecutor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(execute(defaultParams, streamingCtx)).rejects.toThrow(
      'Disk failure creating test products path',
    );

    expect(logSpy.closeCount).toBe(1);
  });

  it('Ordinary Phase 1 regression: when not supervised, error still executes ordinary catch completion marking', async () => {
    const logSpy = setupLogCaptureSpy();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    let capturedProductsPath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Phase 1 building...\n');
        throw new Error('Phase 1 ordinary error');
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const execute = createTestExecutor(mockExecutor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(execute(defaultParams, streamingCtx)).rejects.toThrow('Phase 1 ordinary error');

    // In ordinary mode, catch block marks completion according to existing behavior
    expect(markProductsSpy).toHaveBeenCalled();
    expect(logSpy.closeCount).toBe(1);

    expect(capturedProductsPath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).resolves.toBeUndefined();
  });

  it('Ordinary Phase 2 regression: when not supervised, error still executes ordinary finally completion marking', async () => {
    const logSpy = setupLogCaptureSpy();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Phase 1 succeeded\n');
        return mockCommandResponse({
          success: true,
          exitCode: 0,
          output: 'Phase 1 succeeded',
        });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Phase 2 running...\n');
        throw new Error('Phase 2 ordinary error');
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const execute = createTestExecutor(mockExecutor, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(execute(defaultParams, streamingCtx)).rejects.toThrow('Phase 2 ordinary error');

    // In ordinary mode, finally block marks completion of both artifacts
    expect(markProductsSpy).toHaveBeenCalled();
    expect(markResultSpy).toHaveBeenCalled();
    expect(logSpy.closeCount).toBe(1);

    expect(capturedProductsPath).toBeDefined();
    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).resolves.toBeUndefined();
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).resolves.toBeUndefined();
  });

  it('Metadata reject: closes pipeline log descriptor, suppresses completion markers, stops subsequent commands', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;
    let summaryCalled = false;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] === 'xcrun') {
        if (command.includes('tests')) {
          throw new Error('Metadata xcrun tests rejected');
        }
        if (command.includes('summary')) {
          summaryCalled = true;
          return mockCommandResponse({ success: true, exitCode: 0, output: '{}' });
        }
        throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Build ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Test ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(supervision.run(() => execute(defaultParams, streamingCtx))).rejects.toThrow(
      'Metadata xcrun tests rejected',
    );

    expect(summaryCalled).toBe(false);
    expect(logSpy.closeCount).toBe(1);
    expect(markProductsSpy).not.toHaveBeenCalled();
    expect(markResultSpy).not.toHaveBeenCalled();

    expect(capturedProductsPath).toBeDefined();
    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Metadata unknown exit (null/null): closes pipeline log descriptor, suppresses completion markers, stops subsequent commands', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;
    let summaryCalled = false;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] === 'xcrun') {
        if (command.includes('tests')) {
          const res = await mockCommandResponse({ success: true, output: 'tests ok' });
          Object.assign(res.process, { exitCode: null, signalCode: null });
          return res;
        }
        if (command.includes('summary')) {
          summaryCalled = true;
          return mockCommandResponse({ success: true, exitCode: 0, output: '{}' });
        }
        throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Build ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Test ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(supervision.run(() => execute(defaultParams, streamingCtx))).rejects.toThrow(
      'Managed command completion is uncertain',
    );

    expect(summaryCalled).toBe(false);
    expect(logSpy.closeCount).toBe(1);
    expect(markProductsSpy).not.toHaveBeenCalled();
    expect(markResultSpy).not.toHaveBeenCalled();

    expect(capturedProductsPath).toBeDefined();
    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Metadata open stream: closes pipeline log descriptor, suppresses completion markers, stops subsequent commands', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    const stream = new PassThrough();
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;
    let summaryCalled = false;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] === 'xcrun') {
        if (command.includes('tests')) {
          const res = await mockCommandResponse({ success: true, exitCode: 0, output: 'tests ok' });
          Object.assign(res.process, { stdout: stream });
          return res;
        }
        if (command.includes('summary')) {
          summaryCalled = true;
          return mockCommandResponse({ success: true, exitCode: 0, output: '{}' });
        }
        throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Build ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Test ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    try {
      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      await expect(supervision.run(() => execute(defaultParams, streamingCtx))).rejects.toThrow(
        'Managed command completion is uncertain',
      );

      expect(summaryCalled).toBe(false);
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();

      expect(capturedProductsPath).toBeDefined();
      expect(capturedResultBundlePath).toBeDefined();
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      stream.destroy();
    }
  });

  it('Confirmed non-zero exit code (exit 1) on metadata: falls back to state counts, writes markers, closes log', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;
    const simctlHandler = createSimctlLifecycleHandler(defaultParams.simulatorId!);

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      const simctlRes = await simctlHandler(command);
      if (simctlRes) {
        return simctlRes;
      }
      if (command[0] === 'xcrun') {
        return mockCommandResponse({
          success: false,
          exitCode: 1,
          output: 'xcresulttool failed with error',
        });
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Build ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Test ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    const result = await supervision.run(() => execute(defaultParams, streamingCtx));

    expect(result.didError).toBe(false);
    expect(result.summary.status).toBe('SUCCEEDED');
    expect(markProductsSpy).toHaveBeenCalled();
    expect(markResultSpy).toHaveBeenCalled();
    expect(logSpy.closeCount).toBe(1);

    expect(capturedProductsPath).toBeDefined();
    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).resolves.toBeUndefined();
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).resolves.toBeUndefined();
  });

  it('Invalid JSON on metadata: falls back to state counts, writes markers, closes log', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;
    const simctlHandler = createSimctlLifecycleHandler(defaultParams.simulatorId!);

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      const simctlRes = await simctlHandler(command);
      if (simctlRes) {
        return simctlRes;
      }
      if (command[0] === 'xcrun') {
        return mockCommandResponse({
          success: true,
          exitCode: 0,
          output: 'malformed json { not valid',
        });
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Build ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Test ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    const result = await supervision.run(() => execute(defaultParams, streamingCtx));

    expect(result.didError).toBe(false);
    expect(result.summary.status).toBe('SUCCEEDED');
    expect(markProductsSpy).toHaveBeenCalled();
    expect(markResultSpy).toHaveBeenCalled();
    expect(logSpy.closeCount).toBe(1);

    expect(capturedProductsPath).toBeDefined();
    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).resolves.toBeUndefined();
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).resolves.toBeUndefined();
  });

  it('Valid metadata summary and failures: flows into final domain result, writes markers, closes log', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;
    const simctlHandler = createSimctlLifecycleHandler(defaultParams.simulatorId!);

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      const simctlRes = await simctlHandler(command);
      if (simctlRes) {
        return simctlRes;
      }
      if (command[0] === 'xcrun') {
        if (command.includes('tests')) {
          return mockCommandResponse({
            success: true,
            exitCode: 0,
            output: JSON.stringify({
              testNodes: [
                {
                  name: 'AppTests',
                  nodeType: 'Test Suite',
                  children: [
                    {
                      name: '-[AppTests testAssertionFailure]',
                      nodeType: 'Test Case',
                      result: 'Failed',
                      children: [
                        {
                          name: 'AppTests.swift:42: failed - assertion failed: x == y',
                          nodeType: 'Failure Message',
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          });
        }
        if (command.includes('summary')) {
          return mockCommandResponse({
            success: true,
            exitCode: 0,
            output: JSON.stringify({
              totalTestCount: 10,
              passedTests: 9,
              failedTests: 1,
              skippedTests: 0,
            }),
          });
        }
        throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Build ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Test completed with failure\n');
        // tests failed exit code 65
        return mockCommandResponse({ success: false, exitCode: 65, output: 'Tests failed' });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    const result = await supervision.run(() => execute(defaultParams, streamingCtx));

    expect(result.didError).toBe(true);
    expect(result.summary.status).toBe('FAILED');
    expect(result.summary.counts).toEqual({
      passed: 9,
      failed: 1,
      skipped: 0,
    });
    expect(result.diagnostics.testFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'assertion failed: x == y',
          location: 'AppTests.swift:42',
        }),
      ]),
    );

    expect(markProductsSpy).toHaveBeenCalled();
    expect(markResultSpy).toHaveBeenCalled();
    expect(logSpy.closeCount).toBe(1);

    expect(capturedProductsPath).toBeDefined();
    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).resolves.toBeUndefined();
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).resolves.toBeUndefined();
  });

  it('Phase 1 compile failure in managed mode does not read xcresult', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    let capturedProductsPath: string | undefined;
    let xcrunCalled = false;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] === 'xcrun') {
        xcrunCalled = true;
        return mockCommandResponse({ success: true, exitCode: 0, output: '{}' });
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Compile error\n');
        return mockCommandResponse({
          success: false,
          exitCode: 65,
          output: 'Compile error',
        });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    const result = await supervision.run(() => execute(defaultParams, streamingCtx));

    expect(result.didError).toBe(true);
    expect(xcrunCalled).toBe(false);
    expect(markProductsSpy).toHaveBeenCalled();
    expect(logSpy.closeCount).toBe(1);

    expect(capturedProductsPath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).resolves.toBeUndefined();
  });

  it('Metadata summary reject: closes pipeline log descriptor, suppresses completion markers, propagates error without fallback to sync', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] === 'xcrun') {
        if (command.includes('tests')) {
          return mockCommandResponse({
            success: true,
            exitCode: 0,
            output: JSON.stringify({ testNodes: [] }),
          });
        }
        if (command.includes('summary')) {
          throw new Error('Summary command rejected');
        }
        throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Build ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Test ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(supervision.run(() => execute(defaultParams, streamingCtx))).rejects.toThrow(
      'Summary command rejected',
    );

    expect(logSpy.closeCount).toBe(1);
    expect(markProductsSpy).not.toHaveBeenCalled();
    expect(markResultSpy).not.toHaveBeenCalled();

    expect(capturedProductsPath).toBeDefined();
    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Metadata summary unknown exit (null/null): closes pipeline log descriptor, suppresses completion markers', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] === 'xcrun') {
        if (command.includes('tests')) {
          return mockCommandResponse({
            success: true,
            exitCode: 0,
            output: JSON.stringify({ testNodes: [] }),
          });
        }
        if (command.includes('summary')) {
          const res = await mockCommandResponse({ success: true, output: '{}' });
          Object.assign(res.process, { exitCode: null, signalCode: null });
          return res;
        }
        throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const prodIdx = command.indexOf('-testProductsPath');
      const prodPath = command[prodIdx + 1];
      if (prodIdx !== -1 && prodPath) {
        capturedProductsPath = prodPath;
        await mkdir(prodPath, { recursive: true });
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('build-for-testing')) {
        opts?.onStdout?.('Build ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
      }
      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Test ok\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(supervision.run(() => execute(defaultParams, streamingCtx))).rejects.toThrow(
      'Managed command completion is uncertain',
    );

    expect(logSpy.closeCount).toBe(1);
    expect(markProductsSpy).not.toHaveBeenCalled();
    expect(markResultSpy).not.toHaveBeenCalled();

    expect(capturedProductsPath).toBeDefined();
    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Prepared branch metadata summary failure: suppresses resultBundle completion marker and closes log once', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');
    let capturedResultBundlePath: string | undefined;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      if (command[0] === 'xcrun') {
        if (command.includes('tests')) {
          return mockCommandResponse({
            success: true,
            exitCode: 0,
            output: JSON.stringify({ testNodes: [] }),
          });
        }
        if (command.includes('summary')) {
          throw new Error('Prepared summary command rejected');
        }
        throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
      }
      if (command[0] !== 'xcodebuild') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      const bundleIdx = command.indexOf('-resultBundlePath');
      const bundlePath = command[bundleIdx + 1];
      if (bundleIdx !== -1 && bundlePath) {
        capturedResultBundlePath = bundlePath;
        await mkdir(bundlePath, { recursive: true });
      }

      if (command.includes('test-without-building')) {
        opts?.onStdout?.('Prepared test running...\n');
        return mockCommandResponse({ success: true, exitCode: 0, output: 'Prepared test ok' });
      }
      throw new Error(`Unexpected command phase: ${command.join(' ')}`);
    });

    const supervision = new CommandSupervision();
    const supervised = supervisedExecutor(mockExecutor);
    const execute = createTestExecutor(supervised, {
      toolName: 'test_sim',
      target: 'simulator',
      request: { scheme: 'AppScheme' },
    });

    const { streamingCtx } = createContext();
    await expect(
      supervision.run(() =>
        execute(
          {
            ...defaultParams,
            testProductsPath: join(tempDir, 'fixture.xctestproducts'),
          },
          streamingCtx,
        ),
      ),
    ).rejects.toThrow('Prepared summary command rejected');

    expect(logSpy.closeCount).toBe(1);
    expect(markResultSpy).not.toHaveBeenCalled();

    expect(capturedResultBundlePath).toBeDefined();
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  describe('Stage T3: Simulator command targeting and flag injection contract', () => {
    it('Supervised source-mode: captures real argv in both phases, Phase 1 has no runtime flags, Phase 2 has serialized destination flags exactly once without override, and both have uppercase UUID', async () => {
      const logSpy = setupLogCaptureSpy();
      setupSyncExtractSentinels();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
      const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;
      let capturedResultBundlePath: string | undefined;
      const simctlHandler = createSimctlLifecycleHandler('65faa1dc-6dc9-456d-a88e-3cf5a516f95b');

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        const simctlRes = await simctlHandler(command);
        if (simctlRes) {
          return simctlRes;
        }
        if (command[0] === 'xcrun') {
          if (command.includes('tests')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({ testNodes: [] }),
            });
          }
          if (command.includes('summary')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({
                totalTestCount: 1,
                passedTests: 1,
                failedTests: 0,
                skippedTests: 0,
              }),
            });
          }
          throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
        }
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }
        const bundleIdx = command.indexOf('-resultBundlePath');
        const bundlePath = command[bundleIdx + 1];
        if (bundleIdx !== -1 && bundlePath) {
          capturedResultBundlePath = bundlePath;
          await mkdir(bundlePath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Test ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const lowercaseIdParams: SharedTestExecutorParams = {
        ...defaultParams,
        simulatorId: '65faa1dc-6dc9-456d-a88e-3cf5a516f95b',
      };

      const { streamingCtx } = createContext();
      const result = await supervision.run(() => execute(lowercaseIdParams, streamingCtx));

      expect(result.didError).toBe(false);
      expect(result.summary.status).toBe('SUCCEEDED');
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).toHaveBeenCalled();
      expect(markResultSpy).toHaveBeenCalled();

      // Find Phase 1 and Phase 2 commands
      const phase1Cmd = capturedCommands.find((c) => c.includes('build-for-testing'));
      const phase2Cmd = capturedCommands.find((c) => c.includes('test-without-building'));
      expect(phase1Cmd).toBeDefined();
      expect(phase2Cmd).toBeDefined();

      // Phase 1 assertions:
      // Destination must have uppercase UUID
      const p1DestIdx = phase1Cmd!.indexOf('-destination');
      expect(p1DestIdx).not.toBe(-1);
      expect(phase1Cmd![p1DestIdx + 1]).toBe(
        'platform=iOS Simulator,id=65FAA1DC-6DC9-456D-A88E-3CF5A516F95B',
      );
      // Phase 1 must NOT have any of the three runtime flags
      expect(phase1Cmd).not.toContain('-parallel-testing-enabled');
      expect(phase1Cmd).not.toContain('-maximum-concurrent-test-simulator-destinations');
      expect(phase1Cmd).not.toContain('-test-iterations');

      // Phase 2 assertions:
      // Destination must have uppercase UUID
      const p2DestIdx = phase2Cmd!.indexOf('-destination');
      expect(p2DestIdx).not.toBe(-1);
      expect(phase2Cmd![p2DestIdx + 1]).toBe(
        'platform=iOS Simulator,id=65FAA1DC-6DC9-456D-A88E-3CF5A516F95B',
      );

      // Phase 2 must have -parallel-testing-enabled NO exactly once
      const parallelOccurrences = phase2Cmd!.filter((arg) => arg === '-parallel-testing-enabled');
      expect(parallelOccurrences).toHaveLength(1);
      const parallelIdx = phase2Cmd!.indexOf('-parallel-testing-enabled');
      expect(phase2Cmd![parallelIdx + 1]).toBe('NO');

      // Phase 2 must have -maximum-concurrent-test-simulator-destinations 1 exactly once
      const maxDestOccurrences = phase2Cmd!.filter(
        (arg) => arg === '-maximum-concurrent-test-simulator-destinations',
      );
      expect(maxDestOccurrences).toHaveLength(1);
      const maxDestIdx = phase2Cmd!.indexOf('-maximum-concurrent-test-simulator-destinations');
      expect(phase2Cmd![maxDestIdx + 1]).toBe('1');

      // Phase 2 preserves project/test plan repetitions instead of injecting an invalid single iteration.
      expect(phase2Cmd).not.toContain('-test-iterations');
      expect(phase2Cmd).not.toContain('-retry-tests-on-failure');
      expect(phase2Cmd).not.toContain('-run-tests-until-failure');

      // Flags must not be overridden later in the command
      const trailingAfterMaxDest = phase2Cmd!.slice(maxDestIdx + 2);
      expect(trailingAfterMaxDest).not.toContain('-parallel-testing-enabled');
      expect(trailingAfterMaxDest).not.toContain('-maximum-concurrent-test-simulator-destinations');
      expect(trailingAfterMaxDest).not.toContain('-destination');
    });

    it('Supervised source-mode: rejects non-empty caller extraArgs before any side effects', async () => {
      const createLogSpy = vi.spyOn(logCaptureModule, 'createLogCapture');
      const createProductsPathSpy = vi.spyOn(testProductsModule, 'createDefaultTestProductsPath');
      const createResultBundlePathSpy = vi.spyOn(
        resultBundleModule,
        'createDefaultResultBundlePath',
      );
      const mockExecutor: CommandExecutor = vi.fn();

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              extraArgs: ['-quiet'],
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow(
        'Managed simulator tests only allow -only-testing and -skip-testing selectors in extraArgs',
      );

      expect(mockExecutor).not.toHaveBeenCalled();
      expect(createLogSpy).not.toHaveBeenCalled();
      expect(createProductsPathSpy).not.toHaveBeenCalled();
      expect(createResultBundlePathSpy).not.toHaveBeenCalled();
    });

    it('Supervised source-mode: rejects destination override in caller extraArgs before any side effects', async () => {
      const createLogSpy = vi.spyOn(logCaptureModule, 'createLogCapture');
      const createProductsPathSpy = vi.spyOn(testProductsModule, 'createDefaultTestProductsPath');
      const createResultBundlePathSpy = vi.spyOn(
        resultBundleModule,
        'createDefaultResultBundlePath',
      );
      const mockExecutor: CommandExecutor = vi.fn();

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              extraArgs: ['-destination', 'platform=macOS'],
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow(
        'Managed simulator tests only allow -only-testing and -skip-testing selectors in extraArgs',
      );

      expect(mockExecutor).not.toHaveBeenCalled();
      expect(createLogSpy).not.toHaveBeenCalled();
      expect(createProductsPathSpy).not.toHaveBeenCalled();
      expect(createResultBundlePathSpy).not.toHaveBeenCalled();
    });

    it('Supervised source-mode: rejects non-simulator platform before any side effects', async () => {
      const createLogSpy = vi.spyOn(logCaptureModule, 'createLogCapture');
      const createProductsPathSpy = vi.spyOn(testProductsModule, 'createDefaultTestProductsPath');
      const createResultBundlePathSpy = vi.spyOn(
        resultBundleModule,
        'createDefaultResultBundlePath',
      );
      const mockExecutor: CommandExecutor = vi.fn();

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              platform: XcodePlatform.macOS,
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow('Supervised simulator test runs require a simulator platform');

      expect(mockExecutor).not.toHaveBeenCalled();
      expect(createLogSpy).not.toHaveBeenCalled();
      expect(createProductsPathSpy).not.toHaveBeenCalled();
      expect(createResultBundlePathSpy).not.toHaveBeenCalled();
    });

    it('Supervised source-mode: rejects missing or empty simulatorId before any side effects', async () => {
      const createLogSpy = vi.spyOn(logCaptureModule, 'createLogCapture');
      const createProductsPathSpy = vi.spyOn(testProductsModule, 'createDefaultTestProductsPath');
      const createResultBundlePathSpy = vi.spyOn(
        resultBundleModule,
        'createDefaultResultBundlePath',
      );
      const mockExecutor: CommandExecutor = vi.fn();

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              simulatorId: '',
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow('Supervised simulator test runs require an explicit simulatorId');

      expect(mockExecutor).not.toHaveBeenCalled();
      expect(createLogSpy).not.toHaveBeenCalled();
      expect(createProductsPathSpy).not.toHaveBeenCalled();
      expect(createResultBundlePathSpy).not.toHaveBeenCalled();
    });

    it('Supervised source-mode: rejects mixing simulatorName or deviceId before any side effects', async () => {
      const createLogSpy = vi.spyOn(logCaptureModule, 'createLogCapture');
      const createProductsPathSpy = vi.spyOn(testProductsModule, 'createDefaultTestProductsPath');
      const createResultBundlePathSpy = vi.spyOn(
        resultBundleModule,
        'createDefaultResultBundlePath',
      );
      const mockExecutor: CommandExecutor = vi.fn();

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              simulatorName: 'iPhone 17 Pro',
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow('Supervised simulator test runs do not allow simulatorName');

      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              deviceId: '00008110-001234567890abcdef',
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow('Supervised simulator test runs do not allow deviceId');

      expect(mockExecutor).not.toHaveBeenCalled();
      expect(createLogSpy).not.toHaveBeenCalled();
      expect(createProductsPathSpy).not.toHaveBeenCalled();
      expect(createResultBundlePathSpy).not.toHaveBeenCalled();
    });

    it('Supervised source-mode: rejects blank/empty projectPath or workspacePath and enforces exactly one valid source before any side effects', async () => {
      const createLogSpy = vi.spyOn(logCaptureModule, 'createLogCapture');
      const createProductsPathSpy = vi.spyOn(testProductsModule, 'createDefaultTestProductsPath');
      const createResultBundlePathSpy = vi.spyOn(
        resultBundleModule,
        'createDefaultResultBundlePath',
      );
      const mockExecutor: CommandExecutor = vi.fn();

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();

      // Case 1: valid project + blank workspace
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              projectPath: '/tmp/test/App.xcodeproj',
              workspacePath: '   ',
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow('Supervised simulator test runs do not allow blank workspacePath');

      // Case 2: valid workspace + blank project
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              projectPath: '   ',
              workspacePath: '/tmp/test/App.xcworkspace',
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow('Supervised simulator test runs do not allow blank projectPath');

      // Case 3: standalone blank project
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              projectPath: '   ',
              workspacePath: undefined,
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow('Supervised simulator test runs do not allow blank projectPath');

      // Case 4: standalone blank workspace
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              projectPath: undefined,
              workspacePath: '   ',
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow('Supervised simulator test runs do not allow blank workspacePath');

      // Case 5: neither projectPath nor workspacePath
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              projectPath: undefined,
              workspacePath: undefined,
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow(
        'Supervised simulator test runs require exactly one of projectPath or workspacePath',
      );

      // Case 6: both projectPath and workspacePath (conflict)
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              projectPath: '/tmp/test/App.xcodeproj',
              workspacePath: '/tmp/test/App.xcworkspace',
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow(
        'Supervised simulator test runs require exactly one of projectPath or workspacePath',
      );

      expect(mockExecutor).not.toHaveBeenCalled();
      expect(createLogSpy).not.toHaveBeenCalled();
      expect(createProductsPathSpy).not.toHaveBeenCalled();
      expect(createResultBundlePathSpy).not.toHaveBeenCalled();
    });

    it('Supervised source-mode: rejects missing scheme before any side effects', async () => {
      const createLogSpy = vi.spyOn(logCaptureModule, 'createLogCapture');
      const createProductsPathSpy = vi.spyOn(testProductsModule, 'createDefaultTestProductsPath');
      const createResultBundlePathSpy = vi.spyOn(
        resultBundleModule,
        'createDefaultResultBundlePath',
      );
      const mockExecutor: CommandExecutor = vi.fn();

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      await expect(
        supervision.run(() =>
          execute(
            {
              ...defaultParams,
              scheme: '',
            },
            streamingCtx,
          ),
        ),
      ).rejects.toThrow('Supervised simulator test runs require a non-empty scheme');

      expect(mockExecutor).not.toHaveBeenCalled();
      expect(createLogSpy).not.toHaveBeenCalled();
      expect(createProductsPathSpy).not.toHaveBeenCalled();
      expect(createResultBundlePathSpy).not.toHaveBeenCalled();
    });

    it('Supervised source-mode: supports workspacePath correctly with uppercase UUID and Phase 2 flags', async () => {
      const logSpy = setupLogCaptureSpy();
      setupSyncExtractSentinels();

      const capturedCommands: string[][] = [];
      const simctlHandler = createSimctlLifecycleHandler('65faa1dc-6dc9-456d-a88e-3cf5a516f95b');
      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        const simctlRes = await simctlHandler(command);
        if (simctlRes) {
          return simctlRes;
        }
        if (command[0] === 'xcrun') {
          if (command.includes('tests')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({ testNodes: [] }),
            });
          }
          if (command.includes('summary')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({
                totalTestCount: 1,
                passedTests: 1,
                failedTests: 0,
                skippedTests: 0,
              }),
            });
          }
        }
        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Test ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
        }
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      const result = await supervision.run(() =>
        execute(
          {
            platform: XcodePlatform.iOSSimulator,
            workspacePath: '/tmp/test/App.xcworkspace',
            scheme: 'AppScheme',
            simulatorId: '65faa1dc-6dc9-456d-a88e-3cf5a516f95b',
            extraArgs: [],
          },
          streamingCtx,
        ),
      );

      expect(result.didError).toBe(false);
      expect(result.summary.status).toBe('SUCCEEDED');
      expect(logSpy.closeCount).toBe(1);

      const p1 = capturedCommands.find((c) => c.includes('build-for-testing'))!;
      expect(p1).toContain('-workspace');
      expect(p1).toContain('/tmp/test/App.xcworkspace');
      expect(p1).not.toContain('-parallel-testing-enabled');

      const p2 = capturedCommands.find((c) => c.includes('test-without-building'))!;
      expect(p2).toContain('-parallel-testing-enabled');
      expect(p2[p2.indexOf('-parallel-testing-enabled') + 1]).toBe('NO');
      expect(p2[p2.indexOf('-destination') + 1]).toBe(
        'platform=iOS Simulator,id=65FAA1DC-6DC9-456D-A88E-3CF5A516F95B',
      );
    });

    it('Ordinary mode: preserves caller extraArgs, does not inject concurrency flags into Phase 2, and uppercases simulator UUID', async () => {
      const capturedCommands: string[][] = [];
      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Test ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
        }
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      });

      // Ordinary mode (mockExecutor directly, no CommandSupervision)
      const execute = createTestExecutor(mockExecutor, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      const result = await execute(
        {
          ...defaultParams,
          simulatorId: '65faa1dc-6dc9-456d-a88e-3cf5a516f95b',
          extraArgs: ['-parallel-testing-enabled', 'YES'],
        },
        streamingCtx,
      );

      expect(result.didError).toBe(false);
      const p1 = capturedCommands.find((c) => c.includes('build-for-testing'))!;
      const p2 = capturedCommands.find((c) => c.includes('test-without-building'))!;

      // Both phases uppercase simulator UUID
      expect(p1[p1.indexOf('-destination') + 1]).toBe(
        'platform=iOS Simulator,id=65FAA1DC-6DC9-456D-A88E-3CF5A516F95B',
      );
      expect(p2[p2.indexOf('-destination') + 1]).toBe(
        'platform=iOS Simulator,id=65FAA1DC-6DC9-456D-A88E-3CF5A516F95B',
      );

      // Caller extraArgs preserved, NO forced flags
      expect(p2).toContain('-parallel-testing-enabled');
      expect(p2[p2.indexOf('-parallel-testing-enabled') + 1]).toBe('YES');
      expect(p2).not.toContain('-maximum-concurrent-test-simulator-destinations');
      expect(p2).not.toContain('-test-iterations');
    });

    it('Prepared mode: preserves low-level execution without applying source-only validation, keeping physical device ID unaltered', async () => {
      const capturedCommands: string[][] = [];
      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command[0] === 'xcrun') {
          return mockCommandResponse({ success: true, exitCode: 0, output: '{}' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Prepared test ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Prepared test ok' });
        }
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'device',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      // Low-level prepared execution: has testProductsPath, physical deviceId, non-simulator platform, no projectPath/workspacePath/scheme
      const result = await supervision.run(() =>
        execute(
          {
            platform: XcodePlatform.iOS,
            deviceId: '00008110-001234567890abcdef',
            testProductsPath: join(tempDir, 'products.xctestproducts'),
          },
          streamingCtx,
        ),
      );

      expect(result.didError).toBe(false);
      const p2 = capturedCommands.find((c) => c.includes('test-without-building'))!;
      expect(p2).toBeDefined();
      // Physical deviceId remains lowercase / unaltered
    });
  });

  describe('Stage T4b: Simulator test execution lifecycle and shutdown verification contract', () => {
    it('Normal test exit 0: executes Phase 1 -> Phase 2 -> simctl list -> shutdown -> list, marks artifacts, closes log once', async () => {
      const logSpy = setupLogCaptureSpy();
      setupSyncExtractSentinels();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
      const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;
      let capturedResultBundlePath: string | undefined;
      const simctlHandler = createSimctlLifecycleHandler(defaultParams.simulatorId!);

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        const simctlRes = await simctlHandler(command);
        if (simctlRes) {
          return simctlRes;
        }
        if (command[0] === 'xcrun') {
          if (command.includes('tests')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({ testNodes: [] }),
            });
          }
          if (command.includes('summary')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({
                totalTestCount: 1,
                passedTests: 1,
                failedTests: 0,
                skippedTests: 0,
              }),
            });
          }
          throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
        }
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }
        const bundleIdx = command.indexOf('-resultBundlePath');
        const bundlePath = command[bundleIdx + 1];
        if (bundleIdx !== -1 && bundlePath) {
          capturedResultBundlePath = bundlePath;
          await mkdir(bundlePath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Test ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      const result = await supervision.run(() => execute(defaultParams, streamingCtx));

      // Assertions outside await:
      expect(result.didError).toBe(false);
      expect(result.summary.status).toBe('SUCCEEDED');
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).toHaveBeenCalled();
      expect(markResultSpy).toHaveBeenCalled();

      // Check captured commands full sequence: 2 xcodebuild + 2 xcresulttool + 3 simctl = 7
      expect(capturedCommands).toHaveLength(7);
      expect(capturedCommands[0]).toContain('build-for-testing');
      expect(capturedCommands[1]).toContain('test-without-building');
      expect(capturedCommands[2]).toContain('tests');
      expect(capturedCommands[3]).toContain('summary');
      expect(capturedCommands[4]).toEqual(['xcrun', 'simctl', 'list', 'devices', '--json']);
      expect(capturedCommands[5]).toEqual([
        'xcrun',
        'simctl',
        'shutdown',
        defaultParams.simulatorId!,
      ]);
      expect(capturedCommands[6]).toEqual(['xcrun', 'simctl', 'list', 'devices', '--json']);

      // Filesystem completion markers
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).resolves.toBeUndefined();
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).resolves.toBeUndefined();
    });

    it('Test failure exit 65: executes Phase 1 -> Phase 2 (exit 65) -> xcresult metadata -> simctl list -> shutdown -> list, returns domain failure, marks artifacts', async () => {
      const logSpy = setupLogCaptureSpy();
      setupSyncExtractSentinels();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
      const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;
      let capturedResultBundlePath: string | undefined;
      const simctlHandler = createSimctlLifecycleHandler(defaultParams.simulatorId!);

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        const simctlRes = await simctlHandler(command);
        if (simctlRes) {
          return simctlRes;
        }
        if (command[0] === 'xcrun') {
          if (command.includes('tests')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({ testNodes: [] }),
            });
          }
          if (command.includes('summary')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({
                totalTestCount: 5,
                passedTests: 4,
                failedTests: 1,
                skippedTests: 0,
              }),
            });
          }
          throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
        }
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }
        const bundleIdx = command.indexOf('-resultBundlePath');
        const bundlePath = command[bundleIdx + 1];
        if (bundleIdx !== -1 && bundlePath) {
          capturedResultBundlePath = bundlePath;
          await mkdir(bundlePath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Tests failed\n');
          return mockCommandResponse({ success: false, exitCode: 65, output: 'Tests failed' });
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      const result = await supervision.run(() => execute(defaultParams, streamingCtx));

      // Assertions outside await:
      expect(result.didError).toBe(true);
      expect(result.summary.status).toBe('FAILED');
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).toHaveBeenCalled();
      expect(markResultSpy).toHaveBeenCalled();

      // Check captured commands full sequence: 2 xcodebuild + 2 xcresulttool + 3 simctl = 7
      expect(capturedCommands).toHaveLength(7);
      expect(capturedCommands[0]).toContain('build-for-testing');
      expect(capturedCommands[1]).toContain('test-without-building');
      expect(capturedCommands[2]).toContain('tests');
      expect(capturedCommands[3]).toContain('summary');
      expect(capturedCommands[4]).toEqual(['xcrun', 'simctl', 'list', 'devices', '--json']);
      expect(capturedCommands[5]).toEqual([
        'xcrun',
        'simctl',
        'shutdown',
        defaultParams.simulatorId!,
      ]);
      expect(capturedCommands[6]).toEqual(['xcrun', 'simctl', 'list', 'devices', '--json']);

      // Filesystem completion markers
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).resolves.toBeUndefined();
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).resolves.toBeUndefined();
    });

    it('Phase 1 signal termination (SIGTERM): immediately throws SimulatorTestUncertainError, closeCount is 1, 0 markers, Phase 2 not called', async () => {
      const logSpy = setupLogCaptureSpy();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Signal interrupted\n');
          const res = await mockCommandResponse({
            success: false,
            exitCode: 1,
            output: 'Interrupted',
          });
          Object.assign(res.process, { exitCode: null, signalCode: 'SIGTERM' });
          return res;
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      let caughtError: unknown;
      try {
        await supervision.run(() => execute(defaultParams, streamingCtx));
      } catch (err) {
        caughtError = err;
      }

      // Assertions outside await:
      expect(caughtError).toBeInstanceOf(SimulatorTestUncertainError);
      expect((caughtError as Error).message).toContain(
        'Managed test execution interrupted by signal: SIGTERM',
      );
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(capturedCommands).toHaveLength(1);
      expect(capturedCommands[0]).toContain('build-for-testing');
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Phase 1 signal adversarial (signalCode SIGTERM with success true, exitCode 0): immediately throws SimulatorTestUncertainError, closeCount is 1, 0 markers', async () => {
      const logSpy = setupLogCaptureSpy();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Adversarial signal\n');
          const res = await mockCommandResponse({ success: true, exitCode: 0, output: 'ok' });
          Object.assign(res.process, { exitCode: 0, signalCode: 'SIGTERM' });
          return res;
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      let caughtError: unknown;
      try {
        await supervision.run(() => execute(defaultParams, streamingCtx));
      } catch (err) {
        caughtError = err;
      }

      // Assertions outside await:
      expect(caughtError).toBeInstanceOf(SimulatorTestUncertainError);
      expect((caughtError as Error).message).toContain(
        'Managed test execution interrupted by signal: SIGTERM',
      );
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(capturedCommands).toHaveLength(1);
      expect(capturedCommands[0]).toContain('build-for-testing');
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Phase 2 signal termination (SIGKILL): immediately throws SimulatorTestUncertainError, closeCount is 1, 0 markers, metadata and shutdown not called', async () => {
      const logSpy = setupLogCaptureSpy();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
      const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;
      let capturedResultBundlePath: string | undefined;

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }
        const bundleIdx = command.indexOf('-resultBundlePath');
        const bundlePath = command[bundleIdx + 1];
        if (bundleIdx !== -1 && bundlePath) {
          capturedResultBundlePath = bundlePath;
          await mkdir(bundlePath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Phase 2 killed\n');
          const res = await mockCommandResponse({ success: false, exitCode: 1, output: 'Killed' });
          Object.assign(res.process, { exitCode: null, signalCode: 'SIGKILL' });
          return res;
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      let caughtError: unknown;
      try {
        await supervision.run(() => execute(defaultParams, streamingCtx));
      } catch (err) {
        caughtError = err;
      }

      // Assertions outside await:
      expect(caughtError).toBeInstanceOf(SimulatorTestUncertainError);
      expect((caughtError as Error).message).toContain(
        'Managed test execution interrupted by signal: SIGKILL',
      );
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();
      expect(capturedCommands).toHaveLength(2);
      expect(capturedCommands[0]).toContain('build-for-testing');
      expect(capturedCommands[1]).toContain('test-without-building');
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Phase 2 signal adversarial (signalCode SIGKILL with success true, exitCode 0): immediately throws SimulatorTestUncertainError, closeCount is 1, 0 markers', async () => {
      const logSpy = setupLogCaptureSpy();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
      const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;
      let capturedResultBundlePath: string | undefined;

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }
        const bundleIdx = command.indexOf('-resultBundlePath');
        const bundlePath = command[bundleIdx + 1];
        if (bundleIdx !== -1 && bundlePath) {
          capturedResultBundlePath = bundlePath;
          await mkdir(bundlePath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Adversarial ok\n');
          const res = await mockCommandResponse({ success: true, exitCode: 0, output: 'ok' });
          Object.assign(res.process, { exitCode: 0, signalCode: 'SIGKILL' });
          return res;
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      let caughtError: unknown;
      try {
        await supervision.run(() => execute(defaultParams, streamingCtx));
      } catch (err) {
        caughtError = err;
      }

      // Assertions outside await:
      expect(caughtError).toBeInstanceOf(SimulatorTestUncertainError);
      expect((caughtError as Error).message).toContain(
        'Managed test execution interrupted by signal: SIGKILL',
      );
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();
      expect(capturedCommands).toHaveLength(2);
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Inconsistent exit codes (response.exitCode !== process.exitCode): throws SimulatorTestUncertainError', async () => {
      const logSpy = setupLogCaptureSpy();
      const capturedCommands: string[][] = [];

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          const res = await mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
          Object.assign(res.process, { exitCode: 1 });
          return res;
        }
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      let caughtError: unknown;
      try {
        await supervision.run(() => execute(defaultParams, streamingCtx));
      } catch (err) {
        caughtError = err;
      }

      // Assertions outside await:
      expect(caughtError).toBeInstanceOf(SimulatorTestUncertainError);
      expect((caughtError as Error).message).toContain(
        'Inconsistent exit codes: response.exitCode=0, process.exitCode=1',
      );
      expect(logSpy.closeCount).toBe(1);
      expect(capturedCommands).toHaveLength(1);
    });

    it('Inconsistent success state (response.success true but exitCode 65): throws SimulatorTestUncertainError', async () => {
      const logSpy = setupLogCaptureSpy();
      const capturedCommands: string[][] = [];

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build failed\n');
          const res = await mockCommandResponse({
            success: true,
            exitCode: 65,
            output: 'Build failed',
          });
          Object.assign(res.process, { exitCode: 65 });
          return res;
        }
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      let caughtError: unknown;
      try {
        await supervision.run(() => execute(defaultParams, streamingCtx));
      } catch (err) {
        caughtError = err;
      }

      // Assertions outside await:
      expect(caughtError).toBeInstanceOf(SimulatorTestUncertainError);
      expect((caughtError as Error).message).toContain(
        'Inconsistent success state: response.success=true, exitCode=65',
      );
      expect(logSpy.closeCount).toBe(1);
      expect(capturedCommands).toHaveLength(1);
    });

    it.each([1, 64, 66] as const)(
      'Confirmed numeric nonzero exit (exit %i on xcodebuild Phase 1): returns domain failure',
      async (exitCode) => {
        const logSpy = setupLogCaptureSpy();
        const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
        const capturedCommands: string[][] = [];

        const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
          capturedCommands.push([...command]);
          if (command.includes('build-for-testing')) {
            opts?.onStdout?.('Known user failure\n');
            return mockCommandResponse({
              success: false,
              exitCode,
              output: 'Known user failure',
            });
          }
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        });

        const supervision = new CommandSupervision();
        const supervised = supervisedExecutor(mockExecutor);
        const execute = createTestExecutor(supervised, {
          toolName: 'test_sim',
          target: 'simulator',
          request: { scheme: 'AppScheme' },
        });

        const { streamingCtx } = createContext();
        const result = await supervision.run(() => execute(defaultParams, streamingCtx));

        expect(result.didError).toBe(true);
        expect(result.summary.status).toBe('FAILED');
        expect(markProductsSpy).toHaveBeenCalled();
        expect(logSpy.closeCount).toBe(1);
        expect(capturedCommands).toHaveLength(1);
      },
    );

    it('Unexpected exit code (exit 1 on xcodebuild Phase 2): throws SimulatorTestUncertainError, does not call shutdown', async () => {
      const logSpy = setupLogCaptureSpy();
      const capturedCommands: string[][] = [];

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Unknown test runner crash\n');
          return mockCommandResponse({ success: false, exitCode: 1, output: 'Crash' });
        }
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      let caughtError: unknown;
      try {
        await supervision.run(() => execute(defaultParams, streamingCtx));
      } catch (err) {
        caughtError = err;
      }

      // Assertions outside await:
      expect(caughtError).toBeInstanceOf(SimulatorTestUncertainError);
      expect((caughtError as Error).message).toContain('Unexpected xcodebuild test exit code: 1');
      expect(logSpy.closeCount).toBe(1);
      expect(capturedCommands).toHaveLength(2);
      expect(capturedCommands.some((c) => c.includes('simctl'))).toBe(false);
    });

    it('Shutdown initial catalog failure: missing simulator UUID throws SimulatorTestUncertainError, 0 markers', async () => {
      const logSpy = setupLogCaptureSpy();
      setupSyncExtractSentinels();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
      const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;
      let capturedResultBundlePath: string | undefined;

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command[0] === 'xcrun') {
          if (command[1] === 'simctl') {
            // Return empty catalog missing the simulator UUID
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: makeCatalogJson([]),
            });
          }
          if (command.includes('tests')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({ testNodes: [] }),
            });
          }
          if (command.includes('summary')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({
                totalTestCount: 1,
                passedTests: 1,
                failedTests: 0,
                skippedTests: 0,
              }),
            });
          }
          throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
        }
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }
        const bundleIdx = command.indexOf('-resultBundlePath');
        const bundlePath = command[bundleIdx + 1];
        if (bundleIdx !== -1 && bundlePath) {
          capturedResultBundlePath = bundlePath;
          await mkdir(bundlePath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Test ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      let caughtError: unknown;
      try {
        await supervision.run(() => execute(defaultParams, streamingCtx));
      } catch (err) {
        caughtError = err;
      }

      // Assertions outside await:
      expect(caughtError).toBeInstanceOf(SimulatorTestUncertainError);
      expect((caughtError as Error).message).toContain('missing from device catalog');
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();
      // Should stop after initial simctl list: 2 xcodebuild + 2 xcresult + 1 simctl list = 5
      expect(capturedCommands).toHaveLength(5);
      expect(capturedCommands[4]).toEqual(['xcrun', 'simctl', 'list', 'devices', '--json']);
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Shutdown command failure (exit 1 on simctl shutdown): throws SimulatorTestUncertainError, 0 markers', async () => {
      const logSpy = setupLogCaptureSpy();
      setupSyncExtractSentinels();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
      const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;
      let capturedResultBundlePath: string | undefined;

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command[0] === 'xcrun') {
          if (command[1] === 'simctl') {
            if (command[2] === 'list') {
              return mockCommandResponse({
                success: true,
                exitCode: 0,
                output: makeCatalogJson([
                  { udid: defaultParams.simulatorId!, isAvailable: true, state: 'Booted' },
                ]),
              });
            }
            if (command[2] === 'shutdown') {
              return mockCommandResponse({
                success: false,
                exitCode: 1,
                output: 'Shutdown failed: timeout',
              });
            }
          }
          if (command.includes('tests')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({ testNodes: [] }),
            });
          }
          if (command.includes('summary')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({
                totalTestCount: 1,
                passedTests: 1,
                failedTests: 0,
                skippedTests: 0,
              }),
            });
          }
          throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
        }
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }
        const bundleIdx = command.indexOf('-resultBundlePath');
        const bundlePath = command[bundleIdx + 1];
        if (bundleIdx !== -1 && bundlePath) {
          capturedResultBundlePath = bundlePath;
          await mkdir(bundlePath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Test ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      let caughtError: unknown;
      try {
        await supervision.run(() => execute(defaultParams, streamingCtx));
      } catch (err) {
        caughtError = err;
      }

      // Assertions outside await:
      expect(caughtError).toBeInstanceOf(SimulatorTestUncertainError);
      expect((caughtError as Error).message).toContain(
        'Managed simulator command execution failed',
      );
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();
      // Stops after shutdown, no second list: 2 xcodebuild + 2 xcresult + list + shutdown = 6
      expect(capturedCommands).toHaveLength(6);
      expect(capturedCommands[4]).toEqual(['xcrun', 'simctl', 'list', 'devices', '--json']);
      expect(capturedCommands[5]).toEqual([
        'xcrun',
        'simctl',
        'shutdown',
        defaultParams.simulatorId!,
      ]);
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Shutdown post-catalog verification failure (device remains Booted): throws SimulatorTestUncertainError, 0 markers', async () => {
      const logSpy = setupLogCaptureSpy();
      setupSyncExtractSentinels();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
      const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;
      let capturedResultBundlePath: string | undefined;

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command[0] === 'xcrun') {
          if (command[1] === 'simctl') {
            if (command[2] === 'list') {
              // Always return Booted, meaning shutdown did not change state
              return mockCommandResponse({
                success: true,
                exitCode: 0,
                output: makeCatalogJson([
                  { udid: defaultParams.simulatorId!, isAvailable: true, state: 'Booted' },
                ]),
              });
            }
            if (command[2] === 'shutdown') {
              return mockCommandResponse({ success: true, exitCode: 0, output: '' });
            }
          }
          if (command.includes('tests')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({ testNodes: [] }),
            });
          }
          if (command.includes('summary')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({
                totalTestCount: 1,
                passedTests: 1,
                failedTests: 0,
                skippedTests: 0,
              }),
            });
          }
          throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
        }
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }
        const bundleIdx = command.indexOf('-resultBundlePath');
        const bundlePath = command[bundleIdx + 1];
        if (bundleIdx !== -1 && bundlePath) {
          capturedResultBundlePath = bundlePath;
          await mkdir(bundlePath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Test ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      let caughtError: unknown;
      try {
        await supervision.run(() => execute(defaultParams, streamingCtx));
      } catch (err) {
        caughtError = err;
      }

      // Assertions outside await:
      expect(caughtError).toBeInstanceOf(SimulatorTestUncertainError);
      expect((caughtError as Error).message).toContain(
        'Simulator failed to reach Shutdown state: Booted',
      );
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();
      // Runs list -> shutdown -> list: 2 xcodebuild + 2 xcresult + 3 simctl = 7
      expect(capturedCommands).toHaveLength(7);
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Shutdown already in Shutdown state: verifies Shutdown and returns without issuing shutdown command', async () => {
      const logSpy = setupLogCaptureSpy();
      setupSyncExtractSentinels();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
      const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;
      let capturedResultBundlePath: string | undefined;

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command[0] === 'xcrun') {
          if (command[1] === 'simctl') {
            if (command[2] === 'list') {
              // Initially already Shutdown
              return mockCommandResponse({
                success: true,
                exitCode: 0,
                output: makeCatalogJson([
                  { udid: defaultParams.simulatorId!, isAvailable: true, state: 'Shutdown' },
                ]),
              });
            }
            throw new Error(`Unexpected simctl command: ${command.join(' ')}`);
          }
          if (command.includes('tests')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({ testNodes: [] }),
            });
          }
          if (command.includes('summary')) {
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: JSON.stringify({
                totalTestCount: 1,
                passedTests: 1,
                failedTests: 0,
                skippedTests: 0,
              }),
            });
          }
          throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
        }
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }
        const bundleIdx = command.indexOf('-resultBundlePath');
        const bundlePath = command[bundleIdx + 1];
        if (bundleIdx !== -1 && bundlePath) {
          capturedResultBundlePath = bundlePath;
          await mkdir(bundlePath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Test ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      const result = await supervision.run(() => execute(defaultParams, streamingCtx));

      // Assertions outside await:
      expect(result.didError).toBe(false);
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).toHaveBeenCalled();
      expect(markResultSpy).toHaveBeenCalled();
      // Only one simctl list command, NO shutdown command: 2 xcodebuild + 2 xcresult + 1 simctl list = 5
      expect(capturedCommands).toHaveLength(5);
      expect(capturedCommands[4]).toEqual(['xcrun', 'simctl', 'list', 'devices', '--json']);
      expect(capturedCommands.some((c) => c.includes('shutdown'))).toBe(false);
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).resolves.toBeUndefined();
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).resolves.toBeUndefined();
    });

    it('Metadata uncertain error (reject) stops execution before shutdown: 0 simctl commands, 0 markers', async () => {
      const logSpy = setupLogCaptureSpy();
      setupSyncExtractSentinels();
      const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
      const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

      const capturedCommands: string[][] = [];
      let capturedProductsPath: string | undefined;
      let capturedResultBundlePath: string | undefined;

      const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
        capturedCommands.push([...command]);
        if (command[0] === 'xcrun') {
          if (command.includes('tests')) {
            throw new Error('Metadata query rejected');
          }
          throw new Error(`Unexpected xcrun: ${command.join(' ')}`);
        }
        if (command[0] !== 'xcodebuild') {
          throw new Error(`Unexpected command: ${command.join(' ')}`);
        }
        const prodIdx = command.indexOf('-testProductsPath');
        const prodPath = command[prodIdx + 1];
        if (prodIdx !== -1 && prodPath) {
          capturedProductsPath = prodPath;
          await mkdir(prodPath, { recursive: true });
        }
        const bundleIdx = command.indexOf('-resultBundlePath');
        const bundlePath = command[bundleIdx + 1];
        if (bundleIdx !== -1 && bundlePath) {
          capturedResultBundlePath = bundlePath;
          await mkdir(bundlePath, { recursive: true });
        }

        if (command.includes('build-for-testing')) {
          opts?.onStdout?.('Build ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Build ok' });
        }
        if (command.includes('test-without-building')) {
          opts?.onStdout?.('Test ok\n');
          return mockCommandResponse({ success: true, exitCode: 0, output: 'Test ok' });
        }
        throw new Error(`Unexpected command phase: ${command.join(' ')}`);
      });

      const supervision = new CommandSupervision();
      const supervised = supervisedExecutor(mockExecutor);
      const execute = createTestExecutor(supervised, {
        toolName: 'test_sim',
        target: 'simulator',
        request: { scheme: 'AppScheme' },
      });

      const { streamingCtx } = createContext();
      let caughtError: unknown;
      try {
        await supervision.run(() => execute(defaultParams, streamingCtx));
      } catch (err) {
        caughtError = err;
      }

      // Assertions outside await:
      expect((caughtError as Error).message).toContain('Metadata query rejected');
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();
      // NO simctl commands executed at all
      expect(capturedCommands.some((c) => c.includes('simctl'))).toBe(false);
      await expect(
        access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
