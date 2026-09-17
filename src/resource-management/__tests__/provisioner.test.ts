import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createMockExecutor } from '../../test-utils/mock-executors.ts';
import type { CommandExecutor } from '../../utils/CommandExecutor.ts';
import {
  __setTestCommandExecutorOverride,
  __clearTestExecutorOverrides,
} from '../../utils/command.ts';
import type { ToolHandlerContext } from '../../rendering/types.ts';
import { handler } from '../../mcp/tools/resource-management/resource_provision.ts';
import { getMcpOutputSchema } from '../../core/structured-output-schema.ts';
import { toStructuredEnvelope } from '../../utils/structured-output-envelope.ts';
import { renderCliTextTranscript } from '../../utils/renderers/cli-text-renderer.ts';
import { SimulatorResourceManager } from '../manager.ts';
import { provisionSimulator, SimulatorProvisioningFailure } from '../provisioner.ts';
import { resolveManagedWorktree, type ManagedWorktree } from '../worktree.ts';
import { wrapManagedTool } from '../tool-gate.ts';

const specification = {
  deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
  runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
};
type Device = { udid: string; isAvailable: boolean; deviceTypeIdentifier?: string };
let directory: string;
let worktree: ManagedWorktree;
let manager: SimulatorResourceManager;
let executor: CommandExecutor;
let commands: string[][];
let deviceId: string;
let data: {
  devicetypes: { identifier: string }[];
  runtimes: { identifier: string; isAvailable: boolean }[];
  devices: Record<string, Device[]>;
};
let createMode: 'normal' | 'failed' | 'unknown' | 'rejected' | 'invalid';
let malformedCatalog: boolean;
const ctx = (): ToolHandlerContext => ({ emit: () => {}, attach: () => {} });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-provisioner-'));
  const root = join(directory, 'checkout');
  await mkdir(join(root, '.git'), { recursive: true });
  const stateRoot = join(directory, 'state');
  vi.stubEnv('XCODEBUILDMCP_OPERATION_STATE_ROOT', stateRoot);
  vi.stubEnv('XCODEBUILDMCP_OPERATION_CAPACITY', '1');
  commands = [];
  deviceId = randomUUID();
  createMode = 'normal';
  malformedCatalog = false;
  data = {
    devicetypes: [{ identifier: specification.deviceType }],
    runtimes: [{ identifier: specification.runtime, isAvailable: true }],
    devices: { [specification.runtime]: [] },
  };
  executor = async (...args) => {
    const command = args[0];
    commands.push([...command]);
    if (
      command[0] === 'git' &&
      command[1] === '-C' &&
      command[3] === 'rev-parse' &&
      ['--show-toplevel', '--absolute-git-dir'].includes(command[4])
    ) {
      return createMockExecutor({
        output: `${command[4] === '--show-toplevel' ? root : join(root, '.git')}\n`,
      })(...args);
    }
    if (command.join(' ') === 'xcrun simctl list --json') {
      return createMockExecutor({ output: malformedCatalog ? '{broken' : JSON.stringify(data) })(
        ...args,
      );
    }
    if (command.slice(0, 3).join(' ') === 'xcrun simctl create') {
      expect(command).toHaveLength(6);
      expect(command[3]).toMatch(/^XcodeBuildMCP-[a-f0-9-]+$/);
      expect(command.slice(4)).toEqual([specification.deviceType, specification.runtime]);
      expect(args[2]).toBe(false);
      expect(args[4]).toBeUndefined();
      if (createMode === 'rejected') throw new Error('Executor disconnected');
      if (createMode === 'failed') return createMockExecutor({ success: false })(...args);
      data.devices[specification.runtime].push({
        udid: deviceId.toUpperCase(),
        isAvailable: true,
        deviceTypeIdentifier: specification.deviceType,
      });
      return createMockExecutor({
        output: createMode === 'invalid' ? 'not-a-uuid' : `${deviceId.toUpperCase()}\n`,
        ...(createMode === 'unknown'
          ? { process: { exitCode: null, signalCode: null, stdout: null, stderr: null } }
          : {}),
      })(...args);
    }
    throw new Error(`Unexpected fixture command: ${command.join(' ')}`);
  };
  __setTestCommandExecutorOverride(executor);
  manager = await SimulatorResourceManager.open({ stateRoot, maxActiveOperations: 1 });
  worktree = await resolveManagedWorktree(root, executor);
  commands.length = 0;
});

afterEach(async () => {
  __clearTestExecutorOverrides();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it('creates once using explicit identifiers and reuses the binding without more mutations', async () => {
  const binding = await provisionSimulator(manager, worktree, specification, executor);
  expect(binding.simulatorId).toBe(deviceId);
  expect(await provisionSimulator(manager, worktree, specification, executor)).toEqual(binding);
  expect(commands.filter((command) => command[2] === 'create')).toHaveLength(1);
  expect(commands.every((command) => ['list', 'create'].includes(command[2]))).toBe(true);
});

it.each(['runtime', 'deviceType'])(
  'rejects unavailable %s before reserving or creating',
  async (missing) => {
    if (missing === 'runtime') data.runtimes[0].isAvailable = false;
    else data.devicetypes = [];
    await expect(
      provisionSimulator(manager, worktree, specification, executor),
    ).rejects.toBeInstanceOf(SimulatorProvisioningFailure);
    expect(await manager.getProvisioning(worktree.generation)).toBeNull();
    expect(commands).toEqual([['xcrun', 'simctl', 'list', '--json']]);
  },
);

it.each(['failed', 'unknown', 'rejected', 'invalid'] as const)(
  'fences %s creation without publishing a binding or retrying',
  async (mode) => {
    createMode = mode;
    const expected = {
      failed: 'Simulator creation failed',
      unknown: 'completion is uncertain',
      rejected: 'Executor disconnected',
      invalid: 'Invalid UUID',
    }[mode];
    await expect(provisionSimulator(manager, worktree, specification, executor)).rejects.toThrow(
      expected,
    );
    expect(await manager.getBinding(worktree.generation)).toBeNull();
    expect(await manager.getProvisioning(worktree.generation)).toMatchObject({ state: 'blocked' });
    await expect(provisionSimulator(manager, worktree, specification, executor)).rejects.toThrow(
      'requires reconciliation',
    );
    expect(commands.filter((command) => command[2] === 'create')).toHaveLength(1);
  },
);

it('rejects a create response that points to a pre-existing device', async () => {
  data.devices[specification.runtime].push({
    udid: deviceId,
    isAvailable: true,
    deviceTypeIdentifier: specification.deviceType,
  });
  await expect(provisionSimulator(manager, worktree, specification, executor)).rejects.toThrow(
    'pre-existing device',
  );
  expect(await manager.getBinding(worktree.generation)).toBeNull();
});

it('does not publish a binding while verifying the newly created device', async () => {
  let checking!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    checking = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const gated: CommandExecutor = async (...args) => {
    if (args[0][2] === 'list' && ++reads === 2) {
      checking();
      await resume;
      data.devices[specification.runtime] = [];
    }
    return executor(...args);
  };
  const provisioning = provisionSimulator(manager, worktree, specification, gated);
  const rejected = expect(provisioning).rejects.toThrow('missing or unavailable');
  await entered;
  const bindingDuringCheck = await manager.getBinding(worktree.generation);
  const [leaseDuringCheck] = await Promise.allSettled([
    manager.requestLease({
      requestId: randomUUID(),
      owner: { sessionId: randomUUID() },
      worktree,
    }),
  ]);
  release();
  await rejected;
  expect(bindingDuringCheck).toBeNull();
  expect(leaseDuringCheck).toMatchObject({
    status: 'rejected',
    reason: new Error('Worktree has no Simulator binding'),
  });
  expect(await manager.getProvisioning(worktree.generation)).toMatchObject({
    state: 'blocked',
    simulatorId: deviceId,
  });
});

it.each(['missing', 'unavailable', 'wrong-type', 'missing-metadata'])(
  'never replaces an existing binding when its device is %s',
  async (state) => {
    await provisionSimulator(manager, worktree, specification, executor);
    if (state === 'missing') data.devices[specification.runtime] = [];
    if (state === 'unavailable') data.devices[specification.runtime][0].isAvailable = false;
    if (state === 'wrong-type')
      data.devices[specification.runtime][0].deviceTypeIdentifier = 'different';
    if (state === 'missing-metadata')
      delete data.devices[specification.runtime][0].deviceTypeIdentifier;
    const expected =
      state === 'missing-metadata'
        ? 'metadata is missing'
        : state === 'wrong-type'
          ? 'does not match'
          : 'missing or unavailable';
    await expect(provisionSimulator(manager, worktree, specification, executor)).rejects.toThrow(
      expected,
    );
    expect(await manager.getBinding(worktree.generation)).toMatchObject({ simulatorId: deviceId });
    expect(commands.filter((command) => command[2] === 'create')).toHaveLength(1);
  },
);

it('produces schema-valid final output through the managed public handler without fragments', async () => {
  const context = ctx();
  await wrapManagedTool(
    'mcp/tools/resource-management/resource_provision',
    (args, activeContext) => {
      if (!activeContext) throw new Error('Missing fixture context');
      return handler(args, activeContext);
    },
  )(specification, context);
  const output = context.structuredOutput!;
  const validate = new Ajv2020({ strict: true }).compile(
    getMcpOutputSchema({ schema: output.schema, version: output.schemaVersion }),
  );
  expect(
    validate(toStructuredEnvelope(output.result, output.schema, output.schemaVersion)),
    JSON.stringify(validate.errors),
  ).toBe(true);
  expect(output.result).toMatchObject({ didError: false, simulatorId: deviceId });
  expect(renderCliTextTranscript({ structuredOutput: output })).toContain(`Simulator: ${deviceId}`);
  data.runtimes[0].isAvailable = false;
  await handler(specification, context);
  const failure = context.structuredOutput!;
  expect(failure.result).toMatchObject({
    didError: true,
    error: 'Requested Simulator runtime is unavailable',
  });
  expect(
    validate(toStructuredEnvelope(failure.result, failure.schema, failure.schemaVersion)),
  ).toBe(true);
  expect(renderCliTextTranscript({ structuredOutput: failure })).toContain(
    'Simulator provisioning failed',
  );
});

it('lets catalog infrastructure errors surface as runtime errors', async () => {
  malformedCatalog = true;
  const context = ctx();
  await expect(handler(specification, context)).rejects.toThrow(SyntaxError);
  expect(context.structuredOutput).toBeUndefined();
  expect(await manager.getProvisioning(worktree.generation)).toBeNull();
});

it('rejects the public tool when management is disabled before issuing commands', async () => {
  vi.stubEnv('XCODEBUILDMCP_OPERATION_STATE_ROOT', undefined);
  vi.stubEnv('XCODEBUILDMCP_OPERATION_CAPACITY', undefined);
  await expect(handler(specification, ctx())).rejects.toThrow('not enabled');
  expect(commands).toEqual([]);
});
