/**
 * Common Test Utilities - Shared logic for test tools
 *
 * This module provides shared functionality for all xcodebuild-backed test tools across platforms.
 */

import * as path from 'node:path';
import { log } from './logger.ts';
import { constructDestinationString, XcodePlatform } from './xcode.ts';
import { executeXcodeBuildCommand } from './build/index.ts';
import {
  extractTestFailuresFromXcresult,
  extractTestFailuresFromXcresultAsync,
  extractTestSummaryCountsFromXcresultAsync,
} from './xcresult-test-failures.ts';

import { normalizeTestRunnerEnv } from './environment.ts';
import type { CommandExecutor, CommandResponse, CommandExecOptions } from './command.ts';
import { getDefaultCommandExecutor } from './command.ts';
import { type TestPreflightResult } from './test-preflight.ts';

import { createSimulatorTwoPhaseExecutionPlan } from './simulator-test-execution.ts';
import { parseResultBundlePathArgs } from './result-bundle-args.ts';
import {
  createDefaultResultBundlePath,
  markResultBundlePathCompleted,
} from './result-bundle-path.ts';
import {
  createDefaultTestProductsPath,
  markTestProductsPathCompleted,
} from './test-products-path.ts';
import { resolvePathFromCwd } from './path.ts';
import { displayPath } from './build-preflight.ts';
import {
  filterPreparedTestExtraArgs,
  filterTestProductsPathArgs,
  getPreparedTestDestinationArgs,
} from './test-source.ts';
import { isCommandSupervised } from '../resource-management/execution.ts';
import {
  shutdownAndVerifyManagedSimulator,
  SimulatorTestUncertainError,
} from '../resource-management/test-execution.ts';

import type {
  BuildTarget,
  TestResultArtifacts,
  TestResultDomainResult,
} from '../types/domain-results.ts';
import type { BuildInvocationRequest } from '../types/domain-fragments.ts';
import type { StreamingExecutor } from '../types/tool-execution.ts';
import {
  createDomainStreamingPipeline,
  createTestDiscoveryFragment,
  createTestDomainResult,
} from './xcodebuild-domain-results.ts';

function emitXcresultFailures(
  pipeline: ReturnType<typeof createDomainStreamingPipeline>['pipeline'],
  xcresultPath: string,
): void {
  const failures = extractTestFailuresFromXcresult(xcresultPath);
  for (const event of failures) {
    pipeline.emitFragment(event);
  }
}

function getBuildTarget(platform: XcodePlatform): BuildTarget {
  if (String(platform).includes('Simulator')) {
    return 'simulator';
  }
  if (String(platform) === 'macOS') {
    return 'macos';
  }
  return 'device';
}

function getFallbackErrorMessages(
  streamedLines: readonly string[],
  responseContent?: Array<{ type: 'text'; text: string }>,
): string[] {
  return [...streamedLines, ...(responseContent ?? []).map((item) => item.text)];
}

function createXcodebuildTestArtifacts(
  params: Pick<SharedTestExecutorParams, 'deviceId'>,
  started: ReturnType<typeof createDomainStreamingPipeline>,
  xcresultPath?: string,
  preparedTestSource?: Pick<SharedTestExecutorParams, 'testProductsPath' | 'xctestrunPath'>,
): TestResultArtifacts & { testProductsPath?: string; xctestrunPath?: string } {
  return {
    ...(params.deviceId ? { deviceId: params.deviceId } : {}),
    buildLogPath: started.pipeline.logPath,
    ...(xcresultPath ? { xcresultPath } : {}),
    ...(preparedTestSource?.testProductsPath
      ? { testProductsPath: displayPath(preparedTestSource.testProductsPath) }
      : {}),
    ...(preparedTestSource?.xctestrunPath
      ? { xctestrunPath: displayPath(preparedTestSource.xctestrunPath) }
      : {}),
  };
}

function createDisplayedTestDomainResult(
  options: Parameters<typeof createTestDomainResult>[0],
): TestResultDomainResult {
  const result = createTestDomainResult(options);
  return {
    ...result,
    artifacts: {
      ...result.artifacts,
      ...(result.artifacts.buildLogPath
        ? { buildLogPath: displayPath(result.artifacts.buildLogPath) }
        : {}),
      ...(result.artifacts.xcresultPath
        ? { xcresultPath: displayPath(result.artifacts.xcresultPath) }
        : {}),
    },
  };
}

export function resolveTestProgressEnabled(progress: boolean | undefined): boolean {
  return progress ?? process.env.XCODEBUILDMCP_RUNTIME === 'mcp';
}

export interface SharedTestExecutorParams {
  workspacePath?: string;
  projectPath?: string;
  scheme?: string;
  configuration?: string;
  simulatorName?: string;
  simulatorId?: string;
  deviceId?: string;
  useLatestOS?: boolean;
  packageCachePath?: string;
  derivedDataPath?: string;
  extraArgs?: string[];
  preferXcodebuild?: boolean;
  platform: XcodePlatform;
  testRunnerEnv?: Record<string, string>;
  progress?: boolean;
  testProductsPath?: string;
  xctestrunPath?: string;
}

export interface SharedTestExecutorOptions {
  preflight?: TestPreflightResult;
  toolName?: string;
  target?: BuildTarget;
  request: BuildInvocationRequest;
}

function createPreparedTestDestination(params: SharedTestExecutorParams): string | undefined {
  if (String(params.platform).includes('Simulator')) {
    return constructDestinationString(
      params.platform,
      params.simulatorName,
      params.simulatorId ? params.simulatorId.toUpperCase() : undefined,
      params.useLatestOS,
    );
  }
  if (params.platform === XcodePlatform.macOS) {
    return constructDestinationString(params.platform);
  }
  if (params.deviceId) {
    return `platform=${String(params.platform)},id=${params.deviceId}`;
  }
  return undefined;
}

function resolveSourceWorkingDirectory(params: SharedTestExecutorParams): string | undefined {
  const sourcePath = params.workspacePath ?? params.projectPath;
  return sourcePath ? path.dirname(resolvePathFromCwd(sourcePath)) : undefined;
}

async function executePreparedTestCommand(
  params: SharedTestExecutorParams,
  extraArgs: string[],
  resultBundlePath: string,
  executor: CommandExecutor,
  execOpts: CommandExecOptions | undefined,
  pipeline: ReturnType<typeof createDomainStreamingPipeline>['pipeline'],
  destinationArgs?: string[],
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const sourceArgs = params.testProductsPath
    ? ['-testProductsPath', resolvePathFromCwd(params.testProductsPath)]
    : params.xctestrunPath
      ? ['-xctestrun', resolvePathFromCwd(params.xctestrunPath)]
      : [];
  const destination = createPreparedTestDestination(params);
  if (sourceArgs.length === 0) {
    return {
      content: [{ type: 'text', text: 'A prepared test artifact is required.' }],
      isError: true,
    };
  }
  if (!destination) {
    return {
      content: [{ type: 'text', text: 'A destination is required to run prepared tests.' }],
      isError: true,
    };
  }

  const command = [
    'xcodebuild',
    ...sourceArgs,
    ...(destinationArgs && destinationArgs.length > 0
      ? destinationArgs
      : ['-destination', destination]),
    '-collect-test-diagnostics',
    'never',
    ...extraArgs,
    '-resultBundlePath',
    resultBundlePath,
    'test-without-building',
  ];
  const sourceWorkingDirectory = resolveSourceWorkingDirectory(params);
  const response = await executor(command, 'Test Run', false, {
    ...execOpts,
    ...(sourceWorkingDirectory ? { cwd: sourceWorkingDirectory } : {}),
    onStdout: (chunk) => pipeline.onStdout(chunk),
    onStderr: (chunk) => pipeline.onStderr(chunk),
  });

  return response.success
    ? { content: [{ type: 'text', text: 'Test Run test-without-building succeeded.' }] }
    : {
        content: [{ type: 'text', text: 'Test Run test-without-building failed.' }],
        isError: true,
      };
}

type PreparedTestCommandResult = Awaited<ReturnType<typeof executePreparedTestCommand>>;

function createSupervisedXcodeBuildExecutor(
  executor: CommandExecutor,
  options: { allowKnownNonZeroExitCodes: boolean },
): CommandExecutor {
  return async (command, logPrefix, useShell, commandOpts, detached): Promise<CommandResponse> => {
    const response = await executor(command, logPrefix, useShell, commandOpts, detached);

    if (response.process?.signalCode !== null && response.process?.signalCode !== undefined) {
      throw new SimulatorTestUncertainError(
        `Managed test execution interrupted by signal: ${response.process.signalCode}`,
      );
    }

    const processCode = response.process?.exitCode;
    const responseCode = response.exitCode;

    if (processCode !== responseCode) {
      throw new SimulatorTestUncertainError(
        `Inconsistent exit codes: response.exitCode=${responseCode}, process.exitCode=${processCode}`,
      );
    }

    const expectedSuccess = responseCode === 0;
    if (response.success !== expectedSuccess) {
      throw new SimulatorTestUncertainError(
        `Inconsistent success state: response.success=${response.success}, exitCode=${responseCode}`,
      );
    }

    const hasKnownNumericExitCode =
      typeof responseCode === 'number' && Number.isInteger(responseCode) && responseCode >= 0;
    if (
      !hasKnownNumericExitCode ||
      (!options.allowKnownNonZeroExitCodes && responseCode !== 0 && responseCode !== 65)
    ) {
      throw new SimulatorTestUncertainError(
        `Unexpected xcodebuild test exit code: ${responseCode}`,
      );
    }

    return response;
  };
}

function validateSupervisedSourceTestParams(params: SharedTestExecutorParams): void {
  if (params.extraArgs && params.extraArgs.length > 0) {
    throw new Error('Supervised simulator test runs do not allow extraArgs');
  }

  const isSimulator = [
    XcodePlatform.iOSSimulator,
    XcodePlatform.watchOSSimulator,
    XcodePlatform.tvOSSimulator,
    XcodePlatform.visionOSSimulator,
  ].includes(params.platform);
  if (!isSimulator) {
    throw new Error(
      `Supervised simulator test runs require a simulator platform; received ${params.platform}`,
    );
  }

  if (!params.simulatorId || params.simulatorId.trim().length === 0) {
    throw new Error('Supervised simulator test runs require an explicit simulatorId');
  }

  if (params.simulatorName) {
    throw new Error('Supervised simulator test runs do not allow simulatorName');
  }
  if (params.deviceId) {
    throw new Error('Supervised simulator test runs do not allow deviceId');
  }

  if (params.projectPath?.trim().length === 0) {
    throw new Error('Supervised simulator test runs do not allow blank projectPath');
  }
  if (params.workspacePath?.trim().length === 0) {
    throw new Error('Supervised simulator test runs do not allow blank workspacePath');
  }

  const hasProject = Boolean(params.projectPath);
  const hasWorkspace = Boolean(params.workspacePath);
  if ((hasProject && hasWorkspace) || (!hasProject && !hasWorkspace)) {
    throw new Error(
      'Supervised simulator test runs require exactly one of projectPath or workspacePath',
    );
  }

  if (!params.scheme || params.scheme.trim().length === 0) {
    throw new Error('Supervised simulator test runs require a non-empty scheme');
  }
}

export function createTestExecutor(
  executor: CommandExecutor = getDefaultCommandExecutor(),
  options: SharedTestExecutorOptions,
): StreamingExecutor<SharedTestExecutorParams, TestResultDomainResult> {
  return async (params, ctx) => {
    const hasPreparedTestSource = Boolean(params.testProductsPath ?? params.xctestrunPath);
    const isSupervisedSource = isCommandSupervised() && !hasPreparedTestSource;
    let phase2Started = false;
    let shutdownVerified = false;

    if (isSupervisedSource) {
      validateSupervisedSourceTestParams(params);
    }

    const supervisedBuildForTestingExecutor = isSupervisedSource
      ? createSupervisedXcodeBuildExecutor(executor, { allowKnownNonZeroExitCodes: true })
      : executor;
    const supervisedTestWithoutBuildingExecutor = isSupervisedSource
      ? createSupervisedXcodeBuildExecutor(executor, { allowKnownNonZeroExitCodes: false })
      : executor;

    log(
      'info',
      `Starting test run for ${params.scheme ? `scheme ${params.scheme}` : 'prepared tests'} on platform ${params.platform} (executor)`,
    );

    const execOpts: CommandExecOptions | undefined = params.testRunnerEnv
      ? { env: normalizeTestRunnerEnv(params.testRunnerEnv) }
      : undefined;
    const toolName = options.toolName ?? 'test_sim';
    const target = options.target ?? getBuildTarget(params.platform);
    const started = createDomainStreamingPipeline(toolName, 'TEST', ctx, 'test-result');

    try {
      const platformOptions = {
        platform: params.platform,
        simulatorName: params.simulatorName,
        simulatorId: params.simulatorId,
        deviceId: params.deviceId,
        useLatestOS: params.useLatestOS,
        packageCachePath: params.packageCachePath,
        logPrefix: 'Test Run',
      };
      const discoveryEvent = createTestDiscoveryFragment(options.preflight);

      if (discoveryEvent) {
        started.pipeline.emitFragment(discoveryEvent);
      }

      const parsedResultBundleArgs = parseResultBundlePathArgs(params.extraArgs);
      const shouldUseDefaultResultBundlePath = !parsedResultBundleArgs.resultBundlePath;
      const resultBundlePath =
        parsedResultBundleArgs.resultBundlePath ?? createDefaultResultBundlePath(toolName);

      if (!hasPreparedTestSource) {
        const testProductsPath = createDefaultTestProductsPath(toolName);
        const executionPlan = createSimulatorTwoPhaseExecutionPlan({
          extraArgs: parsedResultBundleArgs.remainingArgs,
          preflight: options.preflight,
          supervised: isCommandSupervised(),
        });

        let buildForTestingResult: Awaited<ReturnType<typeof executeXcodeBuildCommand>>;
        try {
          buildForTestingResult = await executeXcodeBuildCommand(
            {
              ...params,
              scheme: params.scheme!,
              extraArgs: [
                ...filterTestProductsPathArgs(executionPlan.buildArgs),
                '-testProductsPath',
                testProductsPath,
              ],
            },
            platformOptions,
            params.preferXcodebuild,
            'build-for-testing',
            supervisedBuildForTestingExecutor,
            execOpts,
            started.pipeline,
            { propagateInfrastructureErrors: true },
          );
        } catch (error) {
          if (!isCommandSupervised()) {
            markTestProductsPathCompleted(testProductsPath);
          }
          throw error;
        }

        if (buildForTestingResult.isError) {
          markTestProductsPathCompleted(testProductsPath);
          return createDisplayedTestDomainResult({
            started,
            succeeded: false,
            target,
            artifacts: createXcodebuildTestArtifacts(params, started),
            fallbackErrorMessages: getFallbackErrorMessages(
              started.stderrLines,
              buildForTestingResult.content,
            ),
            includeDetectedXcresult: false,
            preflight: options.preflight,
            request: options.request,
            summaryCounts: null,
          });
        }

        started.pipeline.emitFragment({
          kind: 'test-result',
          fragment: 'build-stage',
          operation: 'TEST',
          stage: 'RUN_TESTS',
          message: 'Running tests',
        });

        phase2Started = true;
        let testWithoutBuildingResult: PreparedTestCommandResult;
        try {
          testWithoutBuildingResult = await executePreparedTestCommand(
            { ...params, testProductsPath },
            filterPreparedTestExtraArgs(executionPlan.testArgs),
            resultBundlePath,
            supervisedTestWithoutBuildingExecutor,
            execOpts,
            started.pipeline,
            getPreparedTestDestinationArgs(executionPlan.testArgs),
          );
        } finally {
          if (!isCommandSupervised()) {
            markTestProductsPathCompleted(testProductsPath);
            if (shouldUseDefaultResultBundlePath) {
              markResultBundlePathCompleted(resultBundlePath);
            }
          }
        }

        if (isCommandSupervised()) {
          const failures = await extractTestFailuresFromXcresultAsync(executor, resultBundlePath);
          for (const event of failures) {
            started.pipeline.emitFragment(event);
          }
          const summaryCounts = await extractTestSummaryCountsFromXcresultAsync(
            executor,
            resultBundlePath,
          );

          await shutdownAndVerifyManagedSimulator(params.simulatorId!, executor);
          shutdownVerified = true;

          const domainResult = createDisplayedTestDomainResult({
            started,
            succeeded: !testWithoutBuildingResult.isError,
            target,
            artifacts: createXcodebuildTestArtifacts(params, started, resultBundlePath, {
              testProductsPath,
            }),
            fallbackErrorMessages: getFallbackErrorMessages(
              started.stderrLines,
              testWithoutBuildingResult.content,
            ),
            preflight: options.preflight,
            request: options.request,
            summaryCounts,
          });
          markTestProductsPathCompleted(testProductsPath);
          if (shouldUseDefaultResultBundlePath) {
            markResultBundlePathCompleted(resultBundlePath);
          }
          return domainResult;
        }

        emitXcresultFailures(started.pipeline, resultBundlePath);

        return createDisplayedTestDomainResult({
          started,
          succeeded: !testWithoutBuildingResult.isError,
          target,
          artifacts: createXcodebuildTestArtifacts(params, started, resultBundlePath, {
            testProductsPath,
          }),
          fallbackErrorMessages: getFallbackErrorMessages(
            started.stderrLines,
            testWithoutBuildingResult.content,
          ),
          preflight: options.preflight,
          request: options.request,
        });
      }

      started.pipeline.emitFragment({
        kind: 'test-result',
        fragment: 'build-stage',
        operation: 'TEST',
        stage: 'RUN_TESTS',
        message: 'Running tests',
      });

      let preparedTestResult: PreparedTestCommandResult;
      try {
        preparedTestResult = await executePreparedTestCommand(
          params,
          parsedResultBundleArgs.remainingArgs,
          resultBundlePath,
          executor,
          execOpts,
          started.pipeline,
        );
      } finally {
        if (!isCommandSupervised() && shouldUseDefaultResultBundlePath) {
          markResultBundlePathCompleted(resultBundlePath);
        }
      }

      if (isCommandSupervised()) {
        const failures = await extractTestFailuresFromXcresultAsync(executor, resultBundlePath);
        for (const event of failures) {
          started.pipeline.emitFragment(event);
        }
        const summaryCounts = await extractTestSummaryCountsFromXcresultAsync(
          executor,
          resultBundlePath,
        );
        const domainResult = createDisplayedTestDomainResult({
          started,
          succeeded: !preparedTestResult.isError,
          target,
          artifacts: createXcodebuildTestArtifacts(params, started, resultBundlePath, params),
          fallbackErrorMessages: getFallbackErrorMessages(
            started.stderrLines,
            preparedTestResult.content,
          ),
          preflight: options.preflight,
          request: options.request,
          summaryCounts,
        });
        if (shouldUseDefaultResultBundlePath) {
          markResultBundlePathCompleted(resultBundlePath);
        }
        return domainResult;
      }

      emitXcresultFailures(started.pipeline, resultBundlePath);

      return createDisplayedTestDomainResult({
        started,
        succeeded: !preparedTestResult.isError,
        target,
        artifacts: createXcodebuildTestArtifacts(params, started, resultBundlePath, params),
        fallbackErrorMessages: getFallbackErrorMessages(
          started.stderrLines,
          preparedTestResult.content,
        ),
        preflight: options.preflight,
        request: options.request,
      });
    } catch (error) {
      try {
        started.pipeline.finalize(false, Date.now() - started.startedAt);
      } catch {
        // preserve original error
      }
      if (
        isSupervisedSource &&
        phase2Started &&
        !shutdownVerified &&
        !(error instanceof SimulatorTestUncertainError)
      ) {
        throw new SimulatorTestUncertainError(
          `Managed test execution interrupted unexpectedly before shutdown verification: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  };
}
