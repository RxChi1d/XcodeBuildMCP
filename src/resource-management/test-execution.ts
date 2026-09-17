import * as z from 'zod';
import type { CommandExecutor, CommandResponse } from '../utils/CommandExecutor.ts';
import { isCommandSupervised } from './execution.ts';

export class SimulatorTestUncertainError extends Error {
  override readonly name = 'SimulatorTestUncertainError';
}

const deviceEntrySchema = z.object({
  udid: z.string().uuid(),
  isAvailable: z.boolean(),
  state: z.string(),
});

const devicesCatalogSchema = z.object({
  devices: z.record(z.string(), z.array(deviceEntrySchema)),
});

function parseUniqueDeviceFromCatalog(
  rawJson: string,
  targetSimulatorId: string,
): z.infer<typeof deviceEntrySchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (cause) {
    throw new SimulatorTestUncertainError('Failed to parse simulator catalog JSON', { cause });
  }

  const catalogResult = devicesCatalogSchema.safeParse(parsed);
  if (!catalogResult.success) {
    throw new SimulatorTestUncertainError('Simulator catalog schema validation failed', {
      cause: catalogResult.error,
    });
  }

  const matches = Object.values(catalogResult.data.devices)
    .flat()
    .filter((entry) => entry.udid.toLowerCase() === targetSimulatorId.toLowerCase());

  if (matches.length === 0) {
    throw new SimulatorTestUncertainError(
      `Bound Simulator UUID ${targetSimulatorId} missing from device catalog`,
    );
  }

  if (matches.length > 1) {
    throw new SimulatorTestUncertainError(
      `Duplicate entries found for Simulator UUID ${targetSimulatorId} in device catalog`,
    );
  }

  const device = matches[0]!;
  if (!device.isAvailable) {
    throw new SimulatorTestUncertainError(`Bound Simulator ${targetSimulatorId} is unavailable`);
  }

  return device;
}

/**
 * Shut down a dedicated Simulator after testing and verify its Shutdown state.
 * Only operates on the specified dedicated Simulator UUID.
 * Fails loudly if supervised context is missing or if any step is uncertain.
 */
export async function shutdownAndVerifyManagedSimulator(
  simulatorId: string,
  executor: CommandExecutor,
): Promise<void> {
  if (!isCommandSupervised()) {
    throw new SimulatorTestUncertainError(
      'Managed simulator shutdown requires an active supervised context',
    );
  }

  const parsedUuid = z.string().uuid().safeParse(simulatorId);
  if (!parsedUuid.success) {
    throw new SimulatorTestUncertainError(
      `Invalid simulatorId UUID for managed shutdown: ${simulatorId}`,
    );
  }

  async function execute(command: string[], logPrefix: string): Promise<CommandResponse> {
    let response: CommandResponse;
    try {
      response = await executor(command, logPrefix, false);
    } catch (cause) {
      if (cause instanceof SimulatorTestUncertainError) {
        throw cause;
      }
      throw new SimulatorTestUncertainError(
        `Simulator command execution failed or was uncertain: ${command.join(' ')}`,
        { cause },
      );
    }

    if (
      response.success !== true ||
      response.exitCode !== 0 ||
      response.process?.exitCode !== 0 ||
      response.process?.signalCode !== null
    ) {
      throw new SimulatorTestUncertainError(
        `Managed simulator command execution failed or was interrupted: ${command.join(' ')} (success=${response.success}, exitCode=${response.exitCode}, processExitCode=${response.process?.exitCode}, signalCode=${response.process?.signalCode})`,
      );
    }

    return response;
  }

  // 1. Initial list devices query
  const initialCatalogResponse = await execute(
    ['xcrun', 'simctl', 'list', 'devices', '--json'],
    'Query Simulator State Before Shutdown',
  );
  const initialDevice = parseUniqueDeviceFromCatalog(initialCatalogResponse.output, simulatorId);

  // If already Shutdown, verify it and return immediately
  if (initialDevice.state === 'Shutdown') {
    return;
  }

  // If not Booted (e.g. Booting, Shutting Down, or other unknown state), conservatively throw
  if (initialDevice.state !== 'Booted') {
    throw new SimulatorTestUncertainError(
      `Simulator initial state is unexpected for shutdown: ${initialDevice.state}`,
    );
  }

  // 2. Execute shutdown on target UUID, preserving the caller's casing
  await execute(['xcrun', 'simctl', 'shutdown', simulatorId], 'Shutdown Managed Simulator');

  // 3. Post-shutdown list devices query
  const postCatalogResponse = await execute(
    ['xcrun', 'simctl', 'list', 'devices', '--json'],
    'Verify Simulator Shutdown State',
  );
  const postDevice = parseUniqueDeviceFromCatalog(postCatalogResponse.output, simulatorId);

  if (postDevice.state !== 'Shutdown') {
    throw new SimulatorTestUncertainError(
      `Simulator failed to reach Shutdown state: ${postDevice.state}`,
    );
  }
}
