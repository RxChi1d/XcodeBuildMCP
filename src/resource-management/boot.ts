import * as z from 'zod';
import type { CommandExecutor, CommandResponse } from '../utils/CommandExecutor.ts';
import { CommandSupervision } from './execution.ts';

const devicesSchema = z.object({
  devices: z.record(
    z.string(),
    z.array(z.object({ udid: z.uuid(), isAvailable: z.boolean(), state: z.string() })),
  ),
});

export class SimulatorBootPreflightFailure extends Error {}

/** The service may still be mutating the device even after the command exits. */
export class SimulatorReadinessUncertainError extends Error {}

export async function bootManagedSimulator(
  simulatorId: string,
  executor: CommandExecutor,
): Promise<void> {
  const supervision = new CommandSupervision();
  async function execute(command: string[]): Promise<CommandResponse> {
    let result;
    try {
      result = await supervision.execute(executor, [command, 'Managed Simulator boot', false]);
    } catch (cause) {
      throw new SimulatorReadinessUncertainError('Simulator command completion is uncertain', {
        cause,
      });
    }
    if (!supervision.quiescent)
      throw new SimulatorReadinessUncertainError('Simulator command completion is uncertain');
    if (!result.success) throw new Error('Simulator command failed', { cause: result.error });
    return result;
  }
  async function device(): Promise<
    z.infer<typeof devicesSchema>['devices'][string][number] | undefined
  > {
    const result = await execute(['xcrun', 'simctl', 'list', 'devices', '--json']);
    const catalog = devicesSchema.parse(JSON.parse(result.output));
    return Object.values(catalog.devices)
      .flat()
      .find((entry) => entry.udid.toLowerCase() === simulatorId.toLowerCase());
  }

  const before = await device();
  if (!before?.isAvailable)
    throw new SimulatorBootPreflightFailure('Bound Simulator is missing or unavailable');
  if (!['Shutdown', 'Booting', 'Booted'].includes(before.state))
    throw new SimulatorReadinessUncertainError(`Simulator state is uncertain: ${before.state}`);

  // Once boot is requested, every failure retains ownership until reconciliation.
  try {
    await execute(['xcrun', 'simctl', 'bootstatus', simulatorId, '-b']);
    const after = await device();
    if (!after?.isAvailable || after.state !== 'Booted')
      throw new Error('Bound Simulator did not reach the Booted state');
  } catch (cause) {
    throw new SimulatorReadinessUncertainError('Simulator boot readiness could not be confirmed', {
      cause,
    });
  }
}
