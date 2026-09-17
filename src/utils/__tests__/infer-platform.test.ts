import { beforeEach, describe, expect, it } from 'vitest';
import { createMockCommandResponse, createMockExecutor } from '../../test-utils/mock-executors.ts';
import type { CommandExecutor } from '../execution/index.ts';
import { sessionStore } from '../session-store.ts';
import { inferPlatform } from '../infer-platform.ts';
import { XcodePlatform } from '../../types/common.ts';

describe('inferPlatform', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  it('uses cached simulatorPlatform when selector matches session defaults', async () => {
    sessionStore.setDefaults({
      simulatorId: 'SIM-UUID',
      simulatorPlatform: XcodePlatform.tvOSSimulator,
    });

    const executor = createMockExecutor(new Error('Executor should not be called'));
    const result = await inferPlatform({ simulatorId: 'SIM-UUID' }, executor);

    expect(result.platform).toBe(XcodePlatform.tvOSSimulator);
    expect(result.source).toBe('simulator-platform-cache');
  });

  it('ignores cached simulatorPlatform when explicit selector differs', async () => {
    sessionStore.setDefaults({
      simulatorId: 'OLD-SIM-UUID',
      simulatorPlatform: XcodePlatform.watchOSSimulator,
    });

    const mockExecutor: CommandExecutor = async () =>
      createMockCommandResponse({
        success: true,
        output: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
              {
                udid: 'SIM-UUID',
                name: 'Apple TV',
                isAvailable: true,
              },
            ],
          },
        }),
      });

    const result = await inferPlatform({ simulatorId: 'SIM-UUID' }, mockExecutor);

    expect(result.platform).toBe(XcodePlatform.tvOSSimulator);
    expect(result.source).toBe('simulator-runtime');
  });

  it('prefers simulator runtime metadata when simulatorName is provided', async () => {
    const mockExecutor: CommandExecutor = async () =>
      createMockCommandResponse({
        success: true,
        output: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              {
                udid: 'SIM-UUID',
                name: 'iPhone 17 Pro',
                isAvailable: true,
              },
            ],
          },
        }),
      });

    const result = await inferPlatform({ simulatorName: 'iPhone 17 Pro' }, mockExecutor);

    expect(result.platform).toBe(XcodePlatform.iOSSimulator);
    expect(result.source).toBe('simulator-runtime');
  });

  it('reads simulatorName from session defaults and prefers runtime metadata', async () => {
    sessionStore.setDefaults({ simulatorName: 'Apple Watch Ultra 2' });

    const mockExecutor: CommandExecutor = async () =>
      createMockCommandResponse({
        success: true,
        output: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
              {
                udid: 'WATCH-UUID',
                name: 'Apple Watch Ultra 2',
                isAvailable: true,
              },
            ],
          },
        }),
      });

    const result = await inferPlatform({}, mockExecutor);

    expect(result.platform).toBe(XcodePlatform.watchOSSimulator);
    expect(result.source).toBe('simulator-runtime');
  });

  it('does not let session simulatorName override an explicit simulatorId', async () => {
    sessionStore.setDefaults({ simulatorName: 'Apple Watch Ultra 2' });

    const mockExecutor: CommandExecutor = async () =>
      createMockCommandResponse({
        success: true,
        output: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
              {
                udid: 'WATCH-UUID',
                name: 'Apple Watch Ultra 2',
                isAvailable: true,
              },
            ],
            'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
              {
                udid: 'SIM-UUID',
                name: 'Apple TV',
                isAvailable: true,
              },
            ],
          },
        }),
      });

    const result = await inferPlatform({ simulatorId: 'SIM-UUID' }, mockExecutor);

    expect(result.platform).toBe(XcodePlatform.tvOSSimulator);
    expect(result.source).toBe('simulator-runtime');
  });

  it('infers platform from simulator runtime when simulatorId is provided', async () => {
    const mockExecutor: CommandExecutor = async () =>
      createMockCommandResponse({
        success: true,
        output: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
              {
                udid: 'SIM-UUID',
                name: 'Apple TV',
                isAvailable: true,
              },
            ],
          },
        }),
      });

    const result = await inferPlatform({ simulatorId: 'SIM-UUID' }, mockExecutor);

    expect(result.platform).toBe(XcodePlatform.tvOSSimulator);
    expect(result.source).toBe('simulator-runtime');
  });

  it('throws instead of guessing from build settings when the runtime cannot be resolved', async () => {
    const callHistory: string[][] = [];
    const mockExecutor: CommandExecutor = async (command) => {
      callHistory.push(command);

      if (command[0] === 'xcrun') {
        return createMockCommandResponse({
          success: true,
          output: JSON.stringify({ devices: {} }),
        });
      }

      return createMockCommandResponse({
        success: true,
        output: 'SDKROOT = watchsimulator\nSUPPORTED_PLATFORMS = watchsimulator watchos',
      });
    };

    await expect(
      inferPlatform(
        {
          simulatorId: 'SIM-UUID',
          projectPath: '/tmp/Test.xcodeproj',
          scheme: 'WatchScheme',
        },
        mockExecutor,
      ),
    ).rejects.toThrow(/Unable to determine the simulator platform/);

    // Platform inference no longer shells out to xcodebuild -showBuildSettings.
    expect(callHistory).toHaveLength(1);
    expect(callHistory[0]).toEqual(['xcrun', 'simctl', 'list', 'devices', 'available', '--json']);
  });

  it('throws when simulator inference fails and no platform is cached', async () => {
    const mockExecutor: CommandExecutor = async () =>
      createMockCommandResponse({
        success: false,
        error: 'simctl failed',
      });

    await expect(
      inferPlatform(
        {
          simulatorId: 'SIM-UUID',
          workspacePath: '/tmp/Test.xcworkspace',
          scheme: 'UnknownScheme',
        },
        mockExecutor,
      ),
    ).rejects.toThrow(/Unable to determine the simulator platform/);
  });

  it('matches cached simulatorPlatform when selector UUID differs by case', async () => {
    sessionStore.setDefaults({
      simulatorId: '65faa1dc-6dc9-456d-a88e-3cf5a516f95b',
      simulatorPlatform: XcodePlatform.iOSSimulator,
    });

    const executor = createMockExecutor(new Error('Executor should not be called'));
    const result = await inferPlatform(
      { simulatorId: '65FAA1DC-6DC9-456D-A88E-3CF5A516F95B' },
      executor,
    );

    expect(result.platform).toBe(XcodePlatform.iOSSimulator);
    expect(result.source).toBe('simulator-platform-cache');
  });

  it('matches simctl catalog UDID case-insensitively when catalog emits uppercase UDID', async () => {
    const mockExecutor: CommandExecutor = async () =>
      createMockCommandResponse({
        success: true,
        output: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              {
                udid: '65FAA1DC-6DC9-456D-A88E-3CF5A516F95B',
                name: 'iPhone 16 Pro',
                isAvailable: true,
              },
            ],
          },
        }),
      });

    const result = await inferPlatform(
      { simulatorId: '65faa1dc-6dc9-456d-a88e-3cf5a516f95b' },
      mockExecutor,
    );

    expect(result.platform).toBe(XcodePlatform.iOSSimulator);
    expect(result.source).toBe('simulator-runtime');
  });

  it('preserves case-sensitivity for simulatorName in cache and catalog lookup', async () => {
    sessionStore.setDefaults({
      simulatorName: 'iPhone 17 Pro',
      simulatorPlatform: XcodePlatform.iOSSimulator,
    });

    // Cache should not match because simulatorName is case-sensitive
    const mockExecutor: CommandExecutor = async () =>
      createMockCommandResponse({
        success: true,
        output: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              {
                udid: 'SIM-UUID',
                name: 'iPhone 17 Pro',
                isAvailable: true,
              },
            ],
          },
        }),
      });

    // simulatorName 'iphone 17 pro' does not match cache 'iPhone 17 Pro'
    // but simctl matching also requires exact case for name, falling back to name heuristic
    const result = await inferPlatform({ simulatorName: 'iPhone 17 Pro' }, mockExecutor);
    expect(result.source).toBe('simulator-platform-cache');

    const resultDifferentCase = await inferPlatform(
      { simulatorName: 'iphone 17 pro' },
      mockExecutor,
    );
    // Did not match cache, falls through to simctl which requires exact case for name,
    // and therefore falls back to simulator-name heuristic (NOT simulator-runtime)
    expect(resultDifferentCase.source).toBe('simulator-name');
    expect(resultDifferentCase.source).not.toBe('simulator-runtime');
    expect(resultDifferentCase.source).not.toBe('simulator-platform-cache');
  });
});
