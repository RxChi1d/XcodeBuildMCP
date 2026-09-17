import { expect, it } from 'vitest';
import { createScreenshotExecutor } from '../../mcp/tools/ui-automation/screenshot.ts';
import {
  createMockExecutor,
  createMockFileSystemExecutor,
} from '../../test-utils/mock-executors.ts';

it('captures using a lowercase lease UDID when simctl lists the uppercase UUID', async () => {
  const simulatorId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const calls: string[][] = [];
  const unexpectedCommands: string[][] = [];
  const executor = createMockExecutor({});
  const capture = createScreenshotExecutor({
    executor: async (...args) => {
      calls.push(args[0]);
      const result = await executor(...args);
      if (args[0].join(' ') === 'xcrun simctl list devices -j')
        return {
          ...result,
          output: JSON.stringify({
            devices: {
              runtime: [{ udid: simulatorId.toUpperCase(), name: 'Fixture', state: 'Booted' }],
            },
          }),
        };
      if (args[0][0] === 'swift') return { ...result, output: '400,800' };
      if (args[0][0] === 'sips' && args[0].includes('pixelWidth'))
        return { ...result, output: 'pixelWidth: 400\npixelHeight: 800' };
      if (
        args[0].slice(0, 5).join(' ') === `xcrun simctl io ${simulatorId} screenshot` ||
        args[0].slice(0, 3).join(' ') === 'sips -Z 800'
      )
        return result;
      unexpectedCommands.push(args[0]);
      throw new Error('Unexpected screenshot command');
    },
    fileSystemExecutor: createMockFileSystemExecutor(),
  });
  expect(await capture({ simulatorId, returnFormat: 'path' })).toMatchObject({ didError: false });
  expect(calls.some((command) => command[2] === 'io' && command[3] === simulatorId)).toBe(true);
  expect(unexpectedCommands).toEqual([]);
});
