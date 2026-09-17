import * as z from 'zod';
import type { CommandExecutor } from '../utils/CommandExecutor.ts';
import { CommandSupervision } from './execution.ts';
import type {
  SimulatorResourceManager,
  SimulatorBinding,
  SimulatorSpecification,
} from './manager.ts';
import type { ManagedWorktree } from './worktree.ts';

const catalogSchema = z.object({
  devicetypes: z.array(z.object({ identifier: z.string() })),
  runtimes: z.array(z.object({ identifier: z.string(), isAvailable: z.boolean() })),
  devices: z.record(
    z.string(),
    z.array(
      z.object({
        udid: z.uuid(),
        isAvailable: z.boolean(),
        deviceTypeIdentifier: z.string().optional(),
      }),
    ),
  ),
});

/** Expected failures in the user's Simulator workflow, not registry or executor failures. */
export class SimulatorProvisioningFailure extends Error {}

async function catalog(executor: CommandExecutor): Promise<z.infer<typeof catalogSchema>> {
  const result = await executor(['xcrun', 'simctl', 'list', '--json'], 'Simulator catalog', false);
  if (!result.success) throw new Error('Cannot read Simulator catalog', { cause: result.error });
  return catalogSchema.parse(JSON.parse(result.output));
}

/** Creates only through the durable reservation; never boots, deletes, or adopts a device. */
export async function provisionSimulator(
  manager: SimulatorResourceManager,
  worktree: ManagedWorktree,
  specification: SimulatorSpecification,
  executor: CommandExecutor,
): Promise<SimulatorBinding> {
  const before = await catalog(executor);
  if (!before.devicetypes.some((type) => type.identifier === specification.deviceType)) {
    throw new SimulatorProvisioningFailure('Requested Simulator device type is unavailable');
  }
  if (
    !before.runtimes.some(
      (runtime) => runtime.identifier === specification.runtime && runtime.isAvailable,
    )
  ) {
    throw new SimulatorProvisioningFailure('Requested Simulator runtime is unavailable');
  }
  let verifiedCreation = false;
  async function verify(simulatorId: string): Promise<void> {
    const after = await catalog(executor);
    const device = after.devices[specification.runtime]?.find(
      (entry) => entry.udid.toLowerCase() === simulatorId,
    );
    if (!device?.isAvailable) {
      throw new SimulatorProvisioningFailure(
        'Bound Simulator is missing or unavailable; automatic replacement is disabled',
      );
    }
    if (!device.deviceTypeIdentifier)
      throw new Error('Bound Simulator device type metadata is missing');
    if (device.deviceTypeIdentifier !== specification.deviceType) {
      throw new SimulatorProvisioningFailure(
        'Bound Simulator does not match its persisted device type',
      );
    }
  }
  const binding = await manager.provision(
    worktree,
    specification,
    async (request) => {
      const supervision = new CommandSupervision();
      const result = await supervision.execute(executor, [
        [
          'xcrun',
          'simctl',
          'create',
          request.name,
          request.specification.deviceType,
          request.specification.runtime,
        ],
        'Create dedicated Simulator',
        false,
      ]);
      if (!supervision.quiescent) throw new Error('Simulator creation completion is uncertain');
      if (!result.success)
        throw new SimulatorProvisioningFailure(
          'Simulator creation failed; inspect provisioning before retrying',
        );
      const simulatorId = z.uuid().parse(result.output.trim()).toLowerCase();
      if (
        Object.values(before.devices)
          .flat()
          .some((device) => device.udid.toLowerCase() === simulatorId)
      ) {
        throw new Error('Simulator creation returned a pre-existing device');
      }
      return simulatorId;
    },
    async (simulatorId) => {
      await verify(simulatorId);
      verifiedCreation = true;
    },
  );
  if (!verifiedCreation) await verify(binding.simulatorId);
  return binding;
}
