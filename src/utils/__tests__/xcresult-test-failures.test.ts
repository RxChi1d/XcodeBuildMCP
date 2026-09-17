import { describe, expect, it, vi } from 'vitest';
import {
  parseXcresultFailureMessage,
  parseXcresultTestSummaryCounts,
  parseXcresultTestFailures,
  extractTestSummaryCountsFromXcresultAsync,
  extractTestFailuresFromXcresultAsync,
} from '../xcresult-test-failures.ts';
import { createMockExecutor, createMockCommandResponse } from '../../test-utils/mock-executors.ts';
import type { CommandExecutor } from '../command.ts';

async function createSignaledResponse(success: boolean) {
  const response = await createMockExecutor({
    success,
    exitCode: success ? 0 : 1,
  })(['mock']);
  Object.assign(response.process, { exitCode: null, signalCode: 'SIGTERM' });
  return response;
}

describe('parseXcresultTestSummaryCounts', () => {
  it('uses top-level declaration counts instead of device run counts', () => {
    const summary = JSON.stringify({
      totalTestCount: 16,
      passedTests: 16,
      failedTests: 0,
      skippedTests: 0,
      devicesAndConfigurations: [
        {
          totalTestCount: 19,
          passedTests: 19,
          failedTests: 0,
          skippedTests: 0,
        },
      ],
    });

    expect(parseXcresultTestSummaryCounts(summary)).toEqual({
      passed: 16,
      failed: 0,
      skipped: 0,
    });
  });

  it('returns null for malformed JSON summary output', () => {
    expect(parseXcresultTestSummaryCounts('warning: no summary available')).toBeNull();
    expect(parseXcresultTestSummaryCounts('')).toBeNull();
  });
});

describe('parseXcresultFailureMessage', () => {
  it('preserves locations from multi-line Swift Testing failure messages', () => {
    const parsed = parseXcresultFailureMessage(
      'CalculatorServiceTests.swift:37: Expectation failed: (calculator.display → "0") == "999": // This test is designed to fail to test error reporting\n' +
        'This should fail - display should be 0, not 999',
    );

    expect(parsed).toEqual({
      location: 'CalculatorServiceTests.swift:37',
      message:
        'Expectation failed: (calculator.display → "0") == "999"\n' +
        '// This test is designed to fail to test error reporting\n' +
        'This should fail - display should be 0, not 999',
    });
  });

  it('strips xcresult failure prefixes without inventing a zero-line location', () => {
    expect(parseXcresultFailureMessage('AppTests.swift:0: failed - setup failed')).toEqual({
      message: 'setup failed',
    });
  });
});

describe('parseXcresultTestFailures', () => {
  it('parses nested failure nodes and preserves suite context and location', () => {
    const raw = JSON.stringify({
      testNodes: [
        {
          name: 'CalculatorPackageTests',
          nodeType: 'Test Plan',
          children: [
            {
              name: 'CalculatorServiceTests',
              nodeType: 'Test Suite',
              children: [
                {
                  name: '-[CalculatorServiceTests testAddition]',
                  nodeType: 'Test Case',
                  result: 'Failed',
                  children: [
                    {
                      name: 'CalculatorServiceTests.swift:42: failed - 1 + 1 != 3',
                      nodeType: 'Failure Message',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const fragments = parseXcresultTestFailures(raw);
    expect(fragments).toEqual([
      {
        kind: 'test-result',
        fragment: 'test-failure',
        operation: 'TEST',
        suite: 'CalculatorServiceTests',
        test: 'testAddition',
        message: '1 + 1 != 3',
        location: 'CalculatorServiceTests.swift:42',
      },
    ]);
  });

  it('returns empty array on malformed or empty output', () => {
    expect(parseXcresultTestFailures('')).toEqual([]);
    expect(parseXcresultTestFailures('not json')).toEqual([]);
    expect(parseXcresultTestFailures(JSON.stringify({ notTestNodes: true }))).toEqual([]);
  });

  it('returns empty array when encountering null node, wrong-type name, or non-array children without throwing', () => {
    expect(parseXcresultTestFailures(JSON.stringify({ testNodes: [null] }))).toEqual([]);
    expect(
      parseXcresultTestFailures(
        JSON.stringify({ testNodes: [{ name: 'Suite', nodeType: 'Test Suite', children: {} }] }),
      ),
    ).toEqual([]);
    expect(
      parseXcresultTestFailures(
        JSON.stringify({ testNodes: [{ name: 123, nodeType: 'Test Suite' }] }),
      ),
    ).toEqual([]);
    expect(
      parseXcresultTestFailures(JSON.stringify({ testNodes: [{ name: 'Suite', nodeType: 456 }] })),
    ).toEqual([]);
    expect(
      parseXcresultTestFailures(
        JSON.stringify({
          testNodes: [
            {
              name: 'Suite',
              nodeType: 'Test Case',
              result: 'Failed',
              children: [null],
            },
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      parseXcresultTestFailures(
        JSON.stringify({
          testNodes: [
            {
              name: 'Suite',
              nodeType: 'Test Case',
              result: 'Failed',
              children: [{ nodeType: 'Failure Message', name: 789 }],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('discards partial fragments and returns empty array if a corrupted node is encountered after valid ones', () => {
    const raw = JSON.stringify({
      testNodes: [
        {
          name: 'CalculatorPackageTests',
          nodeType: 'Test Plan',
          children: [
            {
              name: 'CalculatorServiceTests',
              nodeType: 'Test Suite',
              children: [
                {
                  name: '-[CalculatorServiceTests testAddition]',
                  nodeType: 'Test Case',
                  result: 'Failed',
                  children: [
                    {
                      name: 'CalculatorServiceTests.swift:42: failed - 1 + 1 != 3',
                      nodeType: 'Failure Message',
                    },
                  ],
                },
              ],
            },
          ],
        },
        null,
      ],
    });

    expect(parseXcresultTestFailures(raw)).toEqual([]);
  });
});

describe('extractTestSummaryCountsFromXcresultAsync', () => {
  it('executes xcresulttool and parses valid summary', async () => {
    const mockExecutor: CommandExecutor = vi.fn(async (command) => {
      expect(command).toEqual([
        'xcrun',
        'xcresulttool',
        'get',
        'test-results',
        'summary',
        '--path',
        '/tmp/test.xcresult',
        '--compact',
      ]);
      return createMockCommandResponse({
        success: true,
        exitCode: 0,
        output: JSON.stringify({
          totalTestCount: 5,
          passedTests: 4,
          failedTests: 1,
          skippedTests: 0,
        }),
      });
    });

    const counts = await extractTestSummaryCountsFromXcresultAsync(
      mockExecutor,
      '/tmp/test.xcresult',
    );
    expect(counts).toEqual({
      passed: 4,
      failed: 1,
      skipped: 0,
    });
  });

  it('returns null on confirmed non-zero exit code', async () => {
    const mockExecutor: CommandExecutor = vi.fn(async () =>
      createMockCommandResponse({
        success: false,
        exitCode: 1,
        output: 'Failed to read xcresult',
      }),
    );

    const counts = await extractTestSummaryCountsFromXcresultAsync(
      mockExecutor,
      '/tmp/test.xcresult',
    );
    expect(counts).toBeNull();
  });

  it.each([
    ['normal', false],
    ['adversarial success', true],
  ])(
    'throws when xcresult summary process is terminated by signal (%s)',
    async (_name, success) => {
      const mockExecutor: CommandExecutor = vi.fn(async () => createSignaledResponse(success));

      await expect(
        extractTestSummaryCountsFromXcresultAsync(mockExecutor, '/tmp/test.xcresult'),
      ).rejects.toThrow('xcresult test summary extraction interrupted by signal: SIGTERM');
    },
  );

  it('propagates executor errors without swallowing', async () => {
    const mockExecutor: CommandExecutor = vi.fn(async () => {
      throw new Error('Supervisor uncertain completion');
    });

    await expect(
      extractTestSummaryCountsFromXcresultAsync(mockExecutor, '/tmp/test.xcresult'),
    ).rejects.toThrow('Supervisor uncertain completion');
  });
});

describe('extractTestFailuresFromXcresultAsync', () => {
  it('executes xcresulttool and parses test failures', async () => {
    const mockExecutor: CommandExecutor = vi.fn(async (command) => {
      expect(command).toEqual([
        'xcrun',
        'xcresulttool',
        'get',
        'test-results',
        'tests',
        '--path',
        '/tmp/test.xcresult',
      ]);
      return createMockCommandResponse({
        success: true,
        exitCode: 0,
        output: JSON.stringify({
          testNodes: [
            {
              name: 'AppTests',
              nodeType: 'Test Suite',
              children: [
                {
                  name: '-[AppTests testFail]',
                  nodeType: 'Test Case',
                  result: 'Failed',
                  children: [
                    {
                      name: 'AppTests.swift:10: failed - Expected true',
                      nodeType: 'Failure Message',
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
    });

    const failures = await extractTestFailuresFromXcresultAsync(mockExecutor, '/tmp/test.xcresult');
    expect(failures).toEqual([
      {
        kind: 'test-result',
        fragment: 'test-failure',
        operation: 'TEST',
        suite: 'AppTests',
        test: 'testFail',
        message: 'Expected true',
        location: 'AppTests.swift:10',
      },
    ]);
  });

  it('returns empty array on confirmed non-zero exit code', async () => {
    const mockExecutor: CommandExecutor = vi.fn(async () =>
      createMockCommandResponse({
        success: false,
        exitCode: 1,
        output: 'xcresulttool failed',
      }),
    );

    const failures = await extractTestFailuresFromXcresultAsync(mockExecutor, '/tmp/test.xcresult');
    expect(failures).toEqual([]);
  });

  it.each([
    ['normal', false],
    ['adversarial success', true],
  ])('throws when xcresult tests process is terminated by signal (%s)', async (_name, success) => {
    const mockExecutor: CommandExecutor = vi.fn(async () => createSignaledResponse(success));

    await expect(
      extractTestFailuresFromXcresultAsync(mockExecutor, '/tmp/test.xcresult'),
    ).rejects.toThrow('xcresult test failure extraction interrupted by signal: SIGTERM');
  });

  it('propagates executor errors without swallowing', async () => {
    const mockExecutor: CommandExecutor = vi.fn(async () => {
      throw new Error('Command failed catastrophically');
    });

    await expect(
      extractTestFailuresFromXcresultAsync(mockExecutor, '/tmp/test.xcresult'),
    ).rejects.toThrow('Command failed catastrophically');
  });
});
