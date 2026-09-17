import { describe, expect, it } from 'vitest';
import { createMockExecutor } from '../../../../test-utils/mock-executors.ts';
import { executeAxeCommand } from '../shared/axe-command.ts';

describe('AXe device identity', () => {
  it.each([
    '65faa1dc-6dc9-456d-a88e-3cf5a516f95b',
    '65FaA1dC-6dc9-456D-a88e-3cf5a516f95B',
    '65FAA1DC-6DC9-456D-A88E-3CF5A516F95B',
  ])('finds the same CoreSimulator device for %s', async (simulatorId) => {
    const executor = createMockExecutor({
      output: '[]',
      onExecute: (command) => {
        // AXe 1.8.0 matches the uppercase CoreSimulator UDID case-sensitively.
        if (command[command.indexOf('--udid') + 1] !== '65FAA1DC-6DC9-456D-A88E-3CF5A516F95B') {
          throw new Error('Simulator not found');
        }
      },
    });

    await expect(
      executeAxeCommand(['describe-ui'], simulatorId, 'describe-ui', executor, {
        getAxePath: () => '/test/axe',
        getBundledAxeEnvironment: () => ({}),
      }),
    ).resolves.toBe('[]');
  });
});
