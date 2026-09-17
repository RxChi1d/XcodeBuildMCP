import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { CommandSupervision, supervisedExecutor } from '../execution.ts';
import {
  shutdownAndVerifyManagedSimulator,
  SimulatorTestUncertainError,
} from '../test-execution.ts';
import { createMockExecutor, type CommandExecutor } from '../../test-utils/mock-executors.ts';

const VALID_SIMULATOR_ID = '65faa1dc-6dc9-456d-a88e-3cf5a516f95b';

const activeStreams: PassThrough[] = [];

function createTrackedPassThrough(): PassThrough {
  const stream = new PassThrough();
  activeStreams.push(stream);
  return stream;
}

afterEach(() => {
  for (const stream of activeStreams) {
    if (!stream.destroyed) {
      stream.destroy();
    }
  }
  activeStreams.length = 0;
});

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

interface MockStep {
  expectedArgs: string[];
  mockResult?: {
    success?: boolean;
    output?: string;
    error?: string;
    exitCode?: number;
    shouldThrow?: Error;
  };
  override?: {
    exitCode?: number;
    processExitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
    stdout?: PassThrough | null;
    stderr?: PassThrough | null;
  };
}

function createStrictQueueExecutor(steps: MockStep[]): {
  executor: CommandExecutor;
  executedCommands: string[][];
} {
  const executedCommands: string[][] = [];
  const queue = [...steps];

  const executor: CommandExecutor = async (command, logPrefix, useShell, opts, detached) => {
    executedCommands.push([...command]);
    const step = queue.shift();
    if (!step) {
      throw new Error(`Unexpected command call (queue empty): ${command.join(' ')}`);
    }

    if (
      command.length !== step.expectedArgs.length ||
      command.some((val, idx) => val !== step.expectedArgs[idx])
    ) {
      throw new Error(
        `Command mismatch: expected [${step.expectedArgs.join(' ')}] but got [${command.join(' ')}]`,
      );
    }

    const delegate = createMockExecutor(step.mockResult ?? { success: true });
    const response = await delegate(command, logPrefix, useShell, opts, detached);

    if (step.override?.exitCode !== undefined) {
      response.exitCode = step.override.exitCode;
    }
    if (step.override?.processExitCode !== undefined) {
      (response.process as { exitCode: number | null }).exitCode = step.override.processExitCode;
    }
    if (step.override?.signalCode !== undefined) {
      (response.process as { signalCode: NodeJS.Signals | null }).signalCode =
        step.override.signalCode;
    }
    if (step.override?.stdout !== undefined) {
      (response.process as { stdout: unknown }).stdout = step.override.stdout;
    }
    if (step.override?.stderr !== undefined) {
      (response.process as { stderr: unknown }).stderr = step.override.stderr;
    }

    return response;
  };

  return { executor, executedCommands };
}

describe('shutdownAndVerifyManagedSimulator', () => {
  describe('pre-condition checks', () => {
    it('fails loudly when isCommandSupervised() is false, executing 0 commands', async () => {
      const { executor, executedCommands } = createStrictQueueExecutor([]);

      await expect(shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, executor)).rejects.toThrow(
        SimulatorTestUncertainError,
      );

      await expect(shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, executor)).rejects.toThrow(
        /supervised context/i,
      );

      expect(executedCommands).toEqual([]);
    });

    it('fails loudly on invalid simulatorId UUID without calling executor', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator('not-a-valid-uuid', supervised),
        ).rejects.toThrow(SimulatorTestUncertainError);
      });

      expect(executedCommands).toEqual([]);
    });
  });

  describe('nominal lifecycle flows', () => {
    it('when simulator is already Shutdown: executes exactly 1 list command and does not call shutdown', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              {
                udid: VALID_SIMULATOR_ID,
                isAvailable: true,
                state: 'Shutdown',
              },
            ]),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised);
      });

      expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
      expect(supervision.quiescent).toBe(true);
    });

    it('when simulator is Booted: executes list, shutdown with caller UUID, and list verification', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              { udid: VALID_SIMULATOR_ID, isAvailable: true, state: 'Booted' },
            ]),
          },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
          mockResult: {
            output: '',
          },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              {
                udid: VALID_SIMULATOR_ID,
                isAvailable: true,
                state: 'Shutdown',
              },
            ]),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised);
      });

      expect(executedCommands).toEqual([
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
        ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
      ]);
      expect(supervision.quiescent).toBe(true);
    });

    it('matches UUID case-insensitively when initial catalog has uppercase UUID and state is Shutdown', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              {
                udid: VALID_SIMULATOR_ID.toUpperCase(),
                isAvailable: true,
                state: 'Shutdown',
              },
            ]),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID.toLowerCase(), supervised);
      });

      expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
    });

    it('matches UUID case-insensitively when post-shutdown catalog has uppercase UUID', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              {
                udid: VALID_SIMULATOR_ID.toLowerCase(),
                isAvailable: true,
                state: 'Booted',
              },
            ]),
          },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID.toLowerCase()],
          mockResult: { output: '' },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              {
                udid: VALID_SIMULATOR_ID.toUpperCase(),
                isAvailable: true,
                state: 'Shutdown',
              },
            ]),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID.toLowerCase(), supervised);
      });

      expect(executedCommands).toEqual([
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
        ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID.toLowerCase()],
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
      ]);
    });
  });

  describe('unexpected initial states', () => {
    it.each(['Booting', 'Shutting Down', 'Unknown', 'Creating'])(
      'when initial state is %s: throws SimulatorTestUncertainError and executes 0 shutdown calls',
      async (initialState) => {
        const supervision = new CommandSupervision();
        const { executor, executedCommands } = createStrictQueueExecutor([
          {
            expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
            mockResult: {
              output: makeCatalogJson([
                {
                  udid: VALID_SIMULATOR_ID,
                  isAvailable: true,
                  state: initialState,
                },
              ]),
            },
          },
        ]);
        const supervised = supervisedExecutor(executor);

        await supervision.run(async () => {
          await expect(
            shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
          ).rejects.toThrow(SimulatorTestUncertainError);
        });

        expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
      },
    );
  });

  describe('initial catalog validation failures', () => {
    it('fails when catalog returns invalid JSON', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: { output: 'this is not valid json' },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(SimulatorTestUncertainError);
      });

      expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
    });

    it('fails when catalog returns invalid schema', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: JSON.stringify({ devices: 'not-a-record' }),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(SimulatorTestUncertainError);
      });

      expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
    });

    it('fails when UUID is missing (0 matches) - never treats missing as success', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              {
                udid: '11111111-1111-4111-a111-111111111111',
                isAvailable: true,
                state: 'Booted',
              },
            ]),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(/missing/i);
      });

      expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
    });

    it('fails when UUID has duplicate entries in same runtime', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              { udid: VALID_SIMULATOR_ID, isAvailable: true, state: 'Booted' },
              {
                udid: VALID_SIMULATOR_ID,
                isAvailable: true,
                state: 'Shutdown',
              },
            ]),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(/duplicate/i);
      });

      expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
    });

    it('fails when duplicate UUID appears across different runtime keys', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson({
              'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                {
                  udid: VALID_SIMULATOR_ID,
                  isAvailable: true,
                  state: 'Booted',
                },
              ],
              'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
                {
                  udid: VALID_SIMULATOR_ID,
                  isAvailable: true,
                  state: 'Shutdown',
                },
              ],
            }),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(/duplicate/i);
      });

      expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
    });

    it('fails when UUID has isAvailable: false', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              { udid: VALID_SIMULATOR_ID, isAvailable: false, state: 'Booted' },
            ]),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(/unavailable/i);
      });

      expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
    });
  });

  describe('post-shutdown catalog validation failures', () => {
    it('fails when post-shutdown catalog returns invalid JSON', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              { udid: VALID_SIMULATOR_ID, isAvailable: true, state: 'Booted' },
            ]),
          },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
          mockResult: { output: '' },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: { output: 'corrupt post json' },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(SimulatorTestUncertainError);
      });

      expect(executedCommands).toEqual([
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
        ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
      ]);
    });

    it('fails when post-shutdown catalog returns invalid schema', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              { udid: VALID_SIMULATOR_ID, isAvailable: true, state: 'Booted' },
            ]),
          },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
          mockResult: { output: '' },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: JSON.stringify({ devices: 'not-an-object' }),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(SimulatorTestUncertainError);
      });

      expect(executedCommands).toEqual([
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
        ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
      ]);
    });

    it('fails when post-shutdown catalog state is still Booted', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              { udid: VALID_SIMULATOR_ID, isAvailable: true, state: 'Booted' },
            ]),
          },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
          mockResult: { output: '' },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              { udid: VALID_SIMULATOR_ID, isAvailable: true, state: 'Booted' },
            ]),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(/Shutdown state/i);
      });

      expect(executedCommands).toEqual([
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
        ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
      ]);
    });

    it('fails when post-shutdown catalog state is Shutting Down', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              { udid: VALID_SIMULATOR_ID, isAvailable: true, state: 'Booted' },
            ]),
          },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
          mockResult: { output: '' },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              {
                udid: VALID_SIMULATOR_ID,
                isAvailable: true,
                state: 'Shutting Down',
              },
            ]),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(/Shutdown state/i);
      });

      expect(executedCommands).toEqual([
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
        ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
      ]);
    });

    it('fails when post-shutdown catalog has missing UUID', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              { udid: VALID_SIMULATOR_ID, isAvailable: true, state: 'Booted' },
            ]),
          },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
          mockResult: { output: '' },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: { output: makeCatalogJson([]) },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(/missing/i);
      });

      expect(executedCommands).toEqual([
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
        ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
      ]);
    });

    it('fails when post-shutdown catalog has duplicate UUID across runtimes', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              { udid: VALID_SIMULATOR_ID, isAvailable: true, state: 'Booted' },
            ]),
          },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
          mockResult: { output: '' },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson({
              'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                {
                  udid: VALID_SIMULATOR_ID,
                  isAvailable: true,
                  state: 'Shutdown',
                },
              ],
              'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
                {
                  udid: VALID_SIMULATOR_ID,
                  isAvailable: true,
                  state: 'Shutdown',
                },
              ],
            }),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(/duplicate/i);
      });

      expect(executedCommands).toEqual([
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
        ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
      ]);
    });

    it('fails when post-shutdown catalog has isAvailable: false', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              { udid: VALID_SIMULATOR_ID, isAvailable: true, state: 'Booted' },
            ]),
          },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
          mockResult: { output: '' },
        },
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: {
            output: makeCatalogJson([
              {
                udid: VALID_SIMULATOR_ID,
                isAvailable: false,
                state: 'Shutdown',
              },
            ]),
          },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(/unavailable/i);
      });

      expect(executedCommands).toEqual([
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
        ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
        ['xcrun', 'simctl', 'list', 'devices', '--json'],
      ]);
    });
  });

  describe('comprehensive failure matrix across command positions (position × failure mode)', () => {
    type FailureScenario = {
      name: string;
      stepConfig: {
        mockResult?: MockStep['mockResult'];
        override?: (streamTracker: () => PassThrough) => MockStep['override'];
      };
    };

    const failureScenarios: FailureScenario[] = [
      {
        name: 'nonzero exitCode (success false)',
        stepConfig: {
          mockResult: { success: false, exitCode: 1, error: 'Command failed' },
        },
      },
      {
        name: 'signal termination with success true and exitCode 0 (adversarial)',
        stepConfig: {
          mockResult: { success: true, exitCode: 0 },
          override: () => ({ signalCode: 'SIGTERM' }),
        },
      },
      {
        name: 'signal termination normal',
        stepConfig: {
          mockResult: { success: false, exitCode: 1 },
          override: () => ({ signalCode: 'SIGKILL' }),
        },
      },
      {
        name: 'rejects with error',
        stepConfig: {
          mockResult: { shouldThrow: new Error('Low level transport reject') },
        },
      },
      {
        name: 'unknown exitCode (null processExitCode and null signalCode)',
        stepConfig: {
          mockResult: { success: true, exitCode: 0 },
          override: () => ({ processExitCode: null, signalCode: null }),
        },
      },
      {
        name: 'open stdout stream (stream not ended/destroyed)',
        stepConfig: {
          mockResult: { success: true, exitCode: 0 },
          override: (tracker) => ({ stdout: tracker() }),
        },
      },
      {
        name: 'open stderr stream (stream not ended/destroyed)',
        stepConfig: {
          mockResult: { success: true, exitCode: 0 },
          override: (tracker) => ({ stderr: tracker() }),
        },
      },
      {
        name: 'inconsistent exit codes: response.exitCode 0 but process.exitCode 1',
        stepConfig: {
          mockResult: { success: true, exitCode: 0 },
          override: () => ({ processExitCode: 1 }),
        },
      },
      {
        name: 'inconsistent exit codes: response.exitCode 1 but process.exitCode 0',
        stepConfig: {
          mockResult: { success: true, exitCode: 1 },
          override: () => ({ processExitCode: 0 }),
        },
      },
    ];

    describe('position 1: initial list command failure stops subsequent commands', () => {
      it.each(failureScenarios)('fails on initial list with $name', async ({ stepConfig }) => {
        const supervision = new CommandSupervision();
        const stepOverride = stepConfig.override
          ? stepConfig.override(createTrackedPassThrough)
          : undefined;
        const { executor, executedCommands } = createStrictQueueExecutor([
          {
            expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
            mockResult: {
              output: makeCatalogJson([
                {
                  udid: VALID_SIMULATOR_ID,
                  isAvailable: true,
                  state: 'Booted',
                },
              ]),
              ...stepConfig.mockResult,
            },
            override: stepOverride,
          },
        ]);
        const supervised = supervisedExecutor(executor);

        await supervision.run(async () => {
          await expect(
            shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
          ).rejects.toThrow(SimulatorTestUncertainError);
        });

        expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
      });
    });

    describe('position 2: shutdown command failure stops post-shutdown list', () => {
      it.each(failureScenarios)('fails on shutdown command with $name', async ({ stepConfig }) => {
        const supervision = new CommandSupervision();
        const stepOverride = stepConfig.override
          ? stepConfig.override(createTrackedPassThrough)
          : undefined;
        const { executor, executedCommands } = createStrictQueueExecutor([
          {
            expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
            mockResult: {
              output: makeCatalogJson([
                {
                  udid: VALID_SIMULATOR_ID,
                  isAvailable: true,
                  state: 'Booted',
                },
              ]),
            },
          },
          {
            expectedArgs: ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
            mockResult: stepConfig.mockResult ?? { output: '' },
            override: stepOverride,
          },
        ]);
        const supervised = supervisedExecutor(executor);

        await supervision.run(async () => {
          await expect(
            shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
          ).rejects.toThrow(SimulatorTestUncertainError);
        });

        expect(executedCommands).toEqual([
          ['xcrun', 'simctl', 'list', 'devices', '--json'],
          ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
        ]);
      });
    });

    describe('position 3: post-shutdown list command failure', () => {
      it.each(failureScenarios)(
        'fails on post-shutdown list with $name',
        async ({ stepConfig }) => {
          const supervision = new CommandSupervision();
          const stepOverride = stepConfig.override
            ? stepConfig.override(createTrackedPassThrough)
            : undefined;
          const { executor, executedCommands } = createStrictQueueExecutor([
            {
              expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
              mockResult: {
                output: makeCatalogJson([
                  {
                    udid: VALID_SIMULATOR_ID,
                    isAvailable: true,
                    state: 'Booted',
                  },
                ]),
              },
            },
            {
              expectedArgs: ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
              mockResult: { output: '' },
            },
            {
              expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
              mockResult: {
                output: makeCatalogJson([
                  {
                    udid: VALID_SIMULATOR_ID,
                    isAvailable: true,
                    state: 'Shutdown',
                  },
                ]),
                ...stepConfig.mockResult,
              },
              override: stepOverride,
            },
          ]);
          const supervised = supervisedExecutor(executor);

          await supervision.run(async () => {
            await expect(
              shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
            ).rejects.toThrow(SimulatorTestUncertainError);
          });

          expect(executedCommands).toEqual([
            ['xcrun', 'simctl', 'list', 'devices', '--json'],
            ['xcrun', 'simctl', 'shutdown', VALID_SIMULATOR_ID],
            ['xcrun', 'simctl', 'list', 'devices', '--json'],
          ]);
        },
      );
    });
  });

  describe('supervision context uncertainty persistence', () => {
    it('confirms uncertainty in the same context blocks subsequent commands from executing and does not invoke raw executor', async () => {
      const supervision = new CommandSupervision();
      const { executor, executedCommands } = createStrictQueueExecutor([
        {
          expectedArgs: ['xcrun', 'simctl', 'list', 'devices', '--json'],
          mockResult: { shouldThrow: new Error('low-level crash') },
        },
      ]);
      const supervised = supervisedExecutor(executor);

      await supervision.run(async () => {
        // First call fails and marks supervision uncertain
        await expect(
          shutdownAndVerifyManagedSimulator(VALID_SIMULATOR_ID, supervised),
        ).rejects.toThrow(SimulatorTestUncertainError);

        expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
        expect(executedCommands).toHaveLength(1);

        // Second call within the same context is rejected by CommandSupervision itself
        await expect(supervised(['echo', 'should-not-run'])).rejects.toThrow(
          /Previous managed command completion is uncertain/,
        );

        // Explicitly assert that raw executor was not invoked a second time
        expect(executedCommands).toEqual([['xcrun', 'simctl', 'list', 'devices', '--json']]);
        expect(executedCommands).toHaveLength(1);
      });
    });
  });
});
