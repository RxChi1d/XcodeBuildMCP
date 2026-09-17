import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestExecutor, type SharedTestExecutorParams } from '../../utils/test-common.ts';
import { XcodePlatform } from '../../utils/xcode.ts';
import { CommandSupervision, supervisedExecutor } from '../execution.ts';
import { createMockExecutor, type CommandExecutor } from '../../test-utils/mock-executors.ts';
import type { CommandResponse } from '../../utils/CommandExecutor.ts';
import * as logCaptureModule from '../../utils/xcodebuild-log-capture.ts';
import * as logPathsModule from '../../utils/log-paths.ts';
import * as testProductsModule from '../../utils/test-products-path.ts';
import * as resultBundleModule from '../../utils/result-bundle-path.ts';
import * as xcresultModule from '../../utils/xcresult-test-failures.ts';
import type { ToolHandlerContext } from '../../rendering/types.ts';
import { createStreamingExecutionContext } from '../../utils/xcodebuild-domain-results.ts';

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

function trackPromiseSettled<T>(promise: Promise<T>) {
  let settled = false;
  let settledResult: { resolved?: T; rejected?: unknown } | undefined;
  promise.then(
    (value) => {
      settled = true;
      settledResult = { resolved: value };
    },
    (reason) => {
      settled = true;
      settledResult = { rejected: reason };
    },
  );
  return {
    isSettled: () => settled,
    getSettledResult: () => settledResult,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('Stage T4b: Deferred async barrier verification for simulator shutdown', () => {
  let tempDir: string;
  let logsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'test-execution-barrier-'));
    logsDir = join(tempDir, 'logs');
    logPathsModule.setXcodeBuildMCPAppDirOverrideForTests(tempDir);
    logCaptureModule.setXcodebuildLogDirOverrideForTests(logsDir);

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

  it('pauses at shutdown command and post-shutdown list: asserts un-settled, 0 markers, closeCount 0 until released', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

    const enteredShutdown = createDeferred<void>();
    const releaseShutdown = createDeferred<void>();
    const enteredPostList = createDeferred<void>();
    const releasePostList = createDeferred<void>();

    const capturedCommands: string[][] = [];
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;
    let simctlListCount = 0;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      capturedCommands.push([...command]);
      if (command[0] === 'xcrun') {
        if (command[1] === 'simctl') {
          if (command[2] === 'list') {
            simctlListCount++;
            if (simctlListCount === 1) {
              // Initial catalog: Simulator is Booted
              return mockCommandResponse({
                success: true,
                exitCode: 0,
                output: makeCatalogJson([
                  { udid: defaultParams.simulatorId!, isAvailable: true, state: 'Booted' },
                ]),
              });
            }
            if (simctlListCount === 2) {
              // Post-shutdown catalog verification barrier:
              enteredPostList.resolve();
              await releasePostList.promise;
              return mockCommandResponse({
                success: true,
                exitCode: 0,
                output: makeCatalogJson([
                  { udid: defaultParams.simulatorId!, isAvailable: true, state: 'Shutdown' },
                ]),
              });
            }
            throw new Error(`Unexpected simctl list invocation count: ${simctlListCount}`);
          }
          if (command[2] === 'shutdown') {
            // Shutdown command barrier:
            enteredShutdown.resolve();
            await releaseShutdown.promise;
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: '',
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
    const executePromise = supervision.run(() => execute(defaultParams, streamingCtx));
    const executeTracker = trackPromiseSettled(executePromise);

    try {
      // 1. Wait until shutdown command mock is entered
      await enteredShutdown.promise;
      await flushMicrotasks();

      // Assertions while paused inside shutdown command:
      expect(executeTracker.isSettled()).toBe(false);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();
      expect(logSpy.closeCount).toBe(0);

      // Release shutdown command
      releaseShutdown.resolve();

      // 2. Wait until post-shutdown list verification mock is entered
      await enteredPostList.promise;
      await flushMicrotasks();

      // Assertions while paused inside post-shutdown list command:
      expect(executeTracker.isSettled()).toBe(false);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();
      expect(logSpy.closeCount).toBe(0);

      // Release post-shutdown list command (returns state 'Shutdown')
      releasePostList.resolve();

      // 3. Await final execution promise to settle
      const result = await executePromise;
      await flushMicrotasks();

      // Assertions after full completion:
      expect(executeTracker.isSettled()).toBe(true);
      expect(result.didError).toBe(false);
      expect(result.summary.status).toBe('SUCCEEDED');
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).toHaveBeenCalledTimes(1);
      expect(markResultSpy).toHaveBeenCalledTimes(1);
    } finally {
      // Guarantee barriers are released so tests do not hang if assertions fail
      releaseShutdown.resolve();
      releasePostList.resolve();
    }

    // Captured command assertions outside await:
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

    // Completion marker file existence on disk
    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).resolves.toBeUndefined();
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).resolves.toBeUndefined();
  });

  it('test failure (exit 65): pauses at shutdown command and post-shutdown list: asserts un-settled, 0 markers, closeCount 0 until released', async () => {
    const logSpy = setupLogCaptureSpy();
    setupSyncExtractSentinels();
    const markProductsSpy = vi.spyOn(testProductsModule, 'markTestProductsPathCompleted');
    const markResultSpy = vi.spyOn(resultBundleModule, 'markResultBundlePathCompleted');

    const enteredShutdown = createDeferred<void>();
    const releaseShutdown = createDeferred<void>();
    const enteredPostList = createDeferred<void>();
    const releasePostList = createDeferred<void>();

    const capturedCommands: string[][] = [];
    let capturedProductsPath: string | undefined;
    let capturedResultBundlePath: string | undefined;
    let simctlListCount = 0;

    const mockExecutor: CommandExecutor = vi.fn(async (command, _prefix, _shell, opts) => {
      capturedCommands.push([...command]);
      if (command[0] === 'xcrun') {
        if (command[1] === 'simctl') {
          if (command[2] === 'list') {
            simctlListCount++;
            if (simctlListCount === 1) {
              return mockCommandResponse({
                success: true,
                exitCode: 0,
                output: makeCatalogJson([
                  { udid: defaultParams.simulatorId!, isAvailable: true, state: 'Booted' },
                ]),
              });
            }
            if (simctlListCount === 2) {
              enteredPostList.resolve();
              await releasePostList.promise;
              return mockCommandResponse({
                success: true,
                exitCode: 0,
                output: makeCatalogJson([
                  { udid: defaultParams.simulatorId!, isAvailable: true, state: 'Shutdown' },
                ]),
              });
            }
            throw new Error(`Unexpected simctl list invocation count: ${simctlListCount}`);
          }
          if (command[2] === 'shutdown') {
            enteredShutdown.resolve();
            await releaseShutdown.promise;
            return mockCommandResponse({
              success: true,
              exitCode: 0,
              output: '',
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
        opts?.onStdout?.('Test failed\n');
        return mockCommandResponse({ success: false, exitCode: 65, output: 'Test failed' });
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
    const executePromise = supervision.run(() => execute(defaultParams, streamingCtx));
    const executeTracker = trackPromiseSettled(executePromise);

    try {
      await enteredShutdown.promise;
      await flushMicrotasks();

      expect(executeTracker.isSettled()).toBe(false);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();
      expect(logSpy.closeCount).toBe(0);

      releaseShutdown.resolve();

      await enteredPostList.promise;
      await flushMicrotasks();

      expect(executeTracker.isSettled()).toBe(false);
      expect(markProductsSpy).not.toHaveBeenCalled();
      expect(markResultSpy).not.toHaveBeenCalled();
      expect(logSpy.closeCount).toBe(0);

      releasePostList.resolve();

      const result = await executePromise;
      await flushMicrotasks();

      expect(executeTracker.isSettled()).toBe(true);
      expect(result.didError).toBe(true);
      expect(result.summary.status).toBe('FAILED');
      expect(logSpy.closeCount).toBe(1);
      expect(markProductsSpy).toHaveBeenCalledTimes(1);
      expect(markResultSpy).toHaveBeenCalledTimes(1);
    } finally {
      releaseShutdown.resolve();
      releasePostList.resolve();
    }

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

    await expect(
      access(testProductsModule.getTestProductsCompletionMarkerPath(capturedProductsPath!)),
    ).resolves.toBeUndefined();
    await expect(
      access(resultBundleModule.getResultBundleCompletionMarkerPath(capturedResultBundlePath!)),
    ).resolves.toBeUndefined();
  });
});
