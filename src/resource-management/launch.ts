import * as z from 'zod';
import type { CommandExecutor, CommandResponse } from '../utils/CommandExecutor.ts';
import type { LaunchResultDomainResult } from '../types/domain-results.ts';
import { buildLaunchFailure, buildLaunchSuccess } from '../utils/app-lifecycle-results.ts';
import { normalizeSimctlChildEnv } from '../utils/environment.ts';
import { CommandSupervision } from './execution.ts';

export class SimulatorLaunchUncertainError extends Error {}

const bundleIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

/** Finite launch only: the app persists, but no host console or log helper is started. */
export async function launchManagedSimulatorApp(
  params: {
    simulatorId: string;
    bundleId: string;
    launchArgs?: string[];
    env?: Record<string, string>;
  },
  executor: CommandExecutor,
): Promise<LaunchResultDomainResult> {
  bundleIdSchema.parse(params.bundleId);
  const artifacts = { simulatorId: params.simulatorId, bundleId: params.bundleId };
  const supervision = new CommandSupervision();
  async function execute(args: Parameters<CommandExecutor>): Promise<CommandResponse> {
    let result;
    try {
      result = await supervision.execute(executor, args);
    } catch (cause) {
      throw new SimulatorLaunchUncertainError('Simulator launch command completion is uncertain', {
        cause,
      });
    }
    if (!supervision.quiescent)
      throw new SimulatorLaunchUncertainError('Simulator launch command completion is uncertain');
    return result;
  }

  const installed = await execute([
    ['xcrun', 'simctl', 'get_app_container', params.simulatorId, params.bundleId, 'app'],
    'Check App Installed',
    false,
  ]);
  if (!installed.success) {
    return buildLaunchFailure(
      artifacts,
      'Cannot access the installed app. Boot the bound Simulator and install the app before launching.',
    );
  }

  const result = await execute([
    [
      'xcrun',
      'simctl',
      'launch',
      '--terminate-running-process',
      params.simulatorId,
      params.bundleId,
      ...(params.launchArgs ?? []),
    ],
    'Launch Managed App',
    false,
    params.env ? { env: normalizeSimctlChildEnv(params.env) } : undefined,
  ]);
  // An exited command alone does not prove whether a failed service request launched the app.
  if (!result.success)
    throw new SimulatorLaunchUncertainError('Simulator app launch outcome is uncertain');
  const banner = result.output.trim().match(/^(.+):\s+([1-9]\d*)$/);
  const processId = banner ? Number(banner[2]) : undefined;
  if (banner?.[1] !== params.bundleId || !Number.isSafeInteger(processId))
    throw new SimulatorLaunchUncertainError('Simulator launch did not return a valid app PID');
  return buildLaunchSuccess({ ...artifacts, processId });
}
