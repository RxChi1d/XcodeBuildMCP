import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod';
import type { ToolSchemaShape } from '../core/plugin-types.ts';
import type { ToolHandlerContext } from '../rendering/types.ts';
import { getDefaultCommandExecutor } from '../utils/command.ts';
import { resourceEnvironment } from './environment.ts';
import { SimulatorResourceManager, type LeaseCredentials } from './manager.ts';
import { resolveManagedWorktree } from './worktree.ts';
import { CommandSupervision } from './execution.ts';
import { SimulatorReadinessUncertainError } from './boot.ts';
import { SimulatorLaunchUncertainError } from './launch.ts';
import { SimulatorTestUncertainError } from './test-execution.ts';
import { clearRuntimeSnapshot } from '../mcp/tools/ui-automation/shared/snapshot-ui-state.ts';

const runtimeId = randomUUID();
const snapshotProvenance = new Map<
  string,
  { namespace: string; requestId: string; callId: string }
>();
const uiModules = new Set([
  'mcp/tools/ui-automation/snapshot_ui',
  'mcp/tools/ui-automation/tap',
  'mcp/tools/ui-automation/type_text',
]);
const snapshotInvalidatingModules = new Set([
  'mcp/tools/simulator/boot_sim',
  'mcp/tools/simulator/build_sim',
  'mcp/tools/simulator/install_app_sim',
  'mcp/tools/simulator/launch_app_sim',
  'mcp/tools/simulator/test_sim',
]);
const credentialSchema = z.object({
  operationRequestId: z.uuid(),
  operationToken: z.uuid(),
  operationSessionId: z.uuid(),
});
const managementModules = new Set([
  'mcp/tools/resource-management/resource_operation',
  'mcp/tools/resource-management/resource_provision',
]);
const supportedModules = new Set([
  ...uiModules,
  'mcp/tools/simulator/boot_sim',
  'mcp/tools/simulator/build_sim',
  'mcp/tools/simulator/launch_app_sim',
  'mcp/tools/simulator/install_app_sim',
  'mcp/tools/simulator/test_sim',
  'mcp/tools/ui-automation/screenshot',
]);

const managedSourceInputs: ToolSchemaShape = {
  scheme: z.string().describe('The scheme to use (Required)'),
  projectPath: z
    .string()
    .optional()
    .describe('Path to .xcodeproj file. Provide EITHER this OR workspacePath, not both'),
  workspacePath: z
    .string()
    .optional()
    .describe('Path to .xcworkspace file. Provide EITHER this OR projectPath, not both'),
  configuration: z.string().optional().describe('Build configuration (Debug, Release, etc.)'),
  derivedDataPath: z.string().optional(),
  preferXcodebuild: z.boolean().optional(),
};

function validateManagedSourceInputs(moduleId: string, args: Record<string, unknown>): void {
  const subject =
    moduleId === 'mcp/tools/simulator/build_sim'
      ? 'Managed builds'
      : moduleId === 'mcp/tools/simulator/test_sim'
        ? 'Managed simulator tests'
        : undefined;
  if (!subject) return;

  if ('simulatorName' in args) {
    throw new Error('Managed calls require a resolved Simulator UUID without a name');
  }

  const hasProject = typeof args.projectPath === 'string' && args.projectPath.trim().length > 0;
  const hasWorkspace =
    typeof args.workspacePath === 'string' && args.workspacePath.trim().length > 0;
  if (typeof args.projectPath === 'string' && args.projectPath.trim().length === 0) {
    throw new Error(`${subject} do not allow blank projectPath`);
  }
  if (typeof args.workspacePath === 'string' && args.workspacePath.trim().length === 0) {
    throw new Error(`${subject} do not allow blank workspacePath`);
  }
  if ((hasProject && hasWorkspace) || (!hasProject && !hasWorkspace)) {
    throw new Error(`${subject} require exactly one of projectPath or workspacePath`);
  }
  if (typeof args.scheme !== 'string' || args.scheme.trim().length === 0) {
    throw new Error(`${subject} require an explicit non-empty scheme`);
  }
  if (typeof args.simulatorId !== 'string' || args.simulatorId.trim().length === 0) {
    throw new Error(`${subject} require an explicit simulatorId`);
  }
  if (!z.uuid().safeParse(args.simulatorId).success) {
    throw new Error('Managed calls require a resolved Simulator UUID without a name');
  }
}

export function managedToolSchema(moduleId: string, schema: ToolSchemaShape): ToolSchemaShape {
  if (!resourceEnvironment() || !supportedModules.has(moduleId)) return schema;
  return {
    ...schema,
    ...(moduleId === 'mcp/tools/simulator/launch_app_sim' ? { bundleId: z.string().min(1) } : {}),
    ...(moduleId === 'mcp/tools/simulator/build_sim' || moduleId === 'mcp/tools/simulator/test_sim'
      ? managedSourceInputs
      : {}),
    simulatorId: z.uuid(),
    ...credentialSchema.shape,
  };
}

export function wrapManagedTool(
  moduleId: string,
  handler: (args: Record<string, unknown>, ctx?: ToolHandlerContext) => Promise<unknown>,
): typeof handler {
  return async (args, ctx) => {
    const environment = resourceEnvironment();
    if (!environment) {
      if (Object.keys(credentialSchema.shape).some((key) => key in args)) {
        throw new Error('Operation credentials require managed resources');
      }
      return handler(args, ctx);
    }
    if (managementModules.has(moduleId)) return handler(args, ctx);
    if (!supportedModules.has(moduleId)) {
      throw new Error('This tool is not yet supported with managed resources');
    }
    if (!ctx) throw new Error('Managed invocation requires a handler context');
    const parsed = credentialSchema.safeParse(args);
    if (!parsed.success) throw new Error('Explicit operation credentials are required');
    const credentials: LeaseCredentials = {
      requestId: parsed.data.operationRequestId,
      token: parsed.data.operationToken,
      sessionId: parsed.data.operationSessionId,
    };
    const toolArgs = { ...args };
    for (const key of Object.keys(credentialSchema.shape)) delete toolArgs[key];
    if (moduleId === 'mcp/tools/simulator/test_sim') {
      if ('buildForTesting' in args) {
        throw new Error('Managed simulator tests do not support buildForTesting');
      }
      if ('testProductsPath' in args || 'xctestrunPath' in args) {
        throw new Error('Managed simulator tests do not support prepared test artifacts');
      }
    }
    validateManagedSourceInputs(moduleId, args);
    let entered = false;
    ctx.managedOperation = {
      async run(params, invoke): Promise<void> {
        if (entered) throw new Error('Managed tool attempted repeated execution');
        entered = true;
        const target = z
          .object({ simulatorId: z.uuid(), simulatorName: z.undefined() })
          .safeParse(params);
        if (!target.success)
          throw new Error('Managed calls require a resolved Simulator UUID without a name');
        if (moduleId === 'mcp/tools/simulator/build_sim') {
          const buildParams = params as Record<string, unknown>;
          if (
            buildParams.extraArgs !== undefined &&
            (!Array.isArray(buildParams.extraArgs) || buildParams.extraArgs.length > 0)
          ) {
            throw new Error('Managed builds do not support extraArgs');
          }
          if (buildParams.buildForTesting === true) {
            throw new Error('Managed builds do not support buildForTesting');
          }
          if (buildParams.testProductsPath !== undefined) {
            throw new Error('Managed builds do not support testProductsPath');
          }
          if (buildParams.preferXcodebuild === false) {
            throw new Error('Managed builds do not support preferXcodebuild=false');
          }
        }
        if (moduleId === 'mcp/tools/simulator/test_sim') {
          const testParams = params as Record<string, unknown>;
          if (
            testParams.extraArgs !== undefined &&
            (!Array.isArray(testParams.extraArgs) || testParams.extraArgs.length > 0)
          ) {
            throw new Error('Managed simulator tests do not allow extraArgs');
          }
          if (testParams.testProductsPath !== undefined || testParams.xctestrunPath !== undefined) {
            throw new Error('Managed simulator tests do not support prepared test artifacts');
          }
          if (testParams.preferXcodebuild === false) {
            throw new Error('Managed simulator tests do not support preferXcodebuild=false');
          }
        }
        const manager = await SimulatorResourceManager.open(environment);
        const worktree = await resolveManagedWorktree(process.cwd(), getDefaultCommandExecutor());
        const binding = await manager.getBinding(worktree.generation);
        if (
          binding?.worktree.root !== worktree.root ||
          binding.worktree.gitDir !== worktree.gitDir
        ) {
          throw new Error('Worktree binding requires reconciliation');
        }
        const activity = { id: randomUUID(), kind: 'call' as const, runtimeId, pid: process.pid };
        const deadline = Date.now() + 30_000;
        while (
          !(await manager.startCall(
            credentials,
            { generation: worktree.generation, simulatorId: target.data.simulatorId },
            activity,
          ))
        ) {
          if (Date.now() >= deadline) throw new Error('Another call still holds this operation');
          await delay(10);
        }
        const supervision = new CommandSupervision();
        let failure: unknown;
        let failed = false;
        const simulatorId = target.data.simulatorId.toLowerCase();
        try {
          const status = await manager.getStatus(credentials.requestId);
          const previousCall = status.completedActivities
            .filter((entry) => entry.kind === 'call')
            .at(-1);
          const provenance = snapshotProvenance.get(simulatorId);
          if (
            provenance?.namespace !== environment.namespace ||
            provenance?.requestId !== credentials.requestId ||
            provenance?.callId !== previousCall?.id ||
            snapshotInvalidatingModules.has(moduleId)
          )
            clearRuntimeSnapshot(simulatorId);
          await supervision.run(invoke);
        } catch (error) {
          failed = true;
          failure = error;
        }
        if (
          !supervision.quiescent ||
          failure instanceof SimulatorReadinessUncertainError ||
          failure instanceof SimulatorLaunchUncertainError ||
          failure instanceof SimulatorTestUncertainError
        ) {
          clearRuntimeSnapshot(simulatorId);
          await manager.block(
            credentials,
            'Tool completion or child-process quiescence is uncertain',
          );
          throw new Error('Managed command completion could not be confirmed', { cause: failure });
        }
        if (failed || ctx.structuredOutput?.result.didError) clearRuntimeSnapshot(simulatorId);
        snapshotProvenance.set(simulatorId, {
          namespace: environment.namespace,
          requestId: credentials.requestId,
          callId: activity.id,
        });
        if (uiModules.has(moduleId)) {
          if (ctx.structuredOutput) {
            const hints = ctx.structuredOutput.renderHints;
            ctx.structuredOutput.renderHints = {
              ...hints,
              runtimeSnapshot: { ...hints?.runtimeSnapshot, managedOperation: true },
            };
          }
          ctx.nextSteps = [];
          delete ctx.nextStepParams;
          delete ctx.nextStepConditionKeys;
        }
        if (
          moduleId === 'mcp/tools/simulator/build_sim' ||
          moduleId === 'mcp/tools/simulator/test_sim'
        ) {
          ctx.nextSteps = [];
          delete ctx.nextStepParams;
          delete ctx.nextStepConditionKeys;
        }
        await manager.finishActivity(credentials, activity.id, runtimeId);
        if (failed) throw failure;
        if (!ctx.structuredOutput) throw new Error('Managed tool did not produce a final result');
      },
    };
    try {
      return await handler(toolArgs, ctx);
    } finally {
      delete ctx.managedOperation;
    }
  };
}
