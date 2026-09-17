import * as z from 'zod';
import { resourceEnvironment } from '../../../resource-management/environment.ts';
import { SimulatorResourceManager } from '../../../resource-management/manager.ts';
import {
  provisionSimulator,
  SimulatorProvisioningFailure,
} from '../../../resource-management/provisioner.ts';
import { resolveManagedWorktree } from '../../../resource-management/worktree.ts';
import { getDefaultCommandExecutor } from '../../../utils/command.ts';
import type { CommandExecutor } from '../../../utils/CommandExecutor.ts';
import { createTypedTool, getHandlerContext } from '../../../utils/typed-tool-factory.ts';
import type { ResourceBindingDomainResult } from '../../../types/domain-results.ts';

const schemaObject = z.object({
  deviceType: z
    .string()
    .startsWith('com.apple.CoreSimulator.SimDeviceType.')
    .describe('Explicit available Simulator device type identifier.'),
  runtime: z
    .string()
    .startsWith('com.apple.CoreSimulator.SimRuntime.')
    .describe('Explicit available Simulator runtime identifier.'),
});
export const schema = schemaObject.shape;

export async function resourceProvisionLogic(
  params: z.infer<typeof schemaObject>,
  executor: CommandExecutor,
): Promise<void> {
  const options = resourceEnvironment();
  if (!options) throw new Error('Resource management is not enabled');
  const worktree = await resolveManagedWorktree(process.cwd(), executor);
  const manager = await SimulatorResourceManager.open(options);
  const result: ResourceBindingDomainResult = {
    kind: 'resource-binding',
    didError: false,
    error: null,
    worktreeGeneration: worktree.generation,
    deviceType: params.deviceType,
    runtime: params.runtime,
    simulatorId: null,
  };
  try {
    const binding = await provisionSimulator(manager, worktree, params, executor);
    result.simulatorId = binding.simulatorId;
  } catch (error) {
    if (!(error instanceof SimulatorProvisioningFailure)) throw error;
    result.didError = true;
    result.error = error.message;
  }
  getHandlerContext().structuredOutput = {
    schema: 'xcodebuildmcp.output.resource-binding',
    schemaVersion: '1',
    result,
  };
}

export const handler = createTypedTool(
  schemaObject,
  resourceProvisionLogic,
  getDefaultCommandExecutor,
);
