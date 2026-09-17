import * as z from 'zod';
import { resourceEnvironment } from '../../../resource-management/environment.ts';
import {
  SimulatorResourceManager,
  type LeaseCredentials,
} from '../../../resource-management/manager.ts';
import { resolveManagedWorktree } from '../../../resource-management/worktree.ts';
import { getDefaultCommandExecutor } from '../../../utils/command.ts';
import type { CommandExecutor } from '../../../utils/execution/index.ts';
import { createTypedTool, getHandlerContext } from '../../../utils/typed-tool-factory.ts';

const schemaObject = z.object({
  action: z.enum(['begin', 'poll', 'status', 'end', 'cancel']),
  requestId: z.uuid().describe('Stable UUID for this operation; reuse when retrying begin.'),
  sessionId: z.uuid().optional().describe('Caller session UUID; required except for status.'),
  token: z
    .uuid()
    .optional()
    .describe('Lease token returned by begin; required for poll/end/cancel.'),
});

export const schema = schemaObject.shape;

export async function resourceOperationLogic(
  params: z.infer<typeof schemaObject>,
  executor: CommandExecutor,
): Promise<void> {
  const options = resourceEnvironment();
  if (!options) throw new Error('Resource management is not enabled');
  if (params.action !== 'status' && !params.sessionId) throw new Error('sessionId is required');
  if (!['begin', 'status'].includes(params.action) && !params.token)
    throw new Error('token is required');
  if (['begin', 'status'].includes(params.action) && params.token)
    throw new Error('This action does not accept a token');
  const manager = await SimulatorResourceManager.open(options);
  const worktree = await resolveManagedWorktree(process.cwd(), executor);
  let token: string | undefined;
  if (params.action === 'begin') {
    const lease = await manager.requestLease({
      requestId: params.requestId,
      owner: { sessionId: params.sessionId! },
      worktree,
    });
    token = lease.token;
  } else {
    const previous = await manager.getStatus(params.requestId);
    if (previous.generation !== worktree.generation)
      throw new Error('Operation belongs to another worktree generation');
    const credentials: LeaseCredentials = {
      requestId: params.requestId,
      sessionId: params.sessionId ?? '',
      token: params.token ?? '',
    };
    if (params.action === 'poll') token = (await manager.poll(credentials)).token;
    if (params.action === 'end') await manager.end(credentials);
    if (params.action === 'cancel') await manager.cancel(credentials);
  }
  const status = await manager.getStatus(params.requestId);
  getHandlerContext().structuredOutput = {
    schema: 'xcodebuildmcp.output.resource-operation',
    schemaVersion: '1',
    result: {
      kind: 'resource-operation',
      didError: false,
      error: null,
      action: params.action,
      requestId: status.requestId,
      sessionId: status.owner.sessionId,
      simulatorId: status.simulatorId,
      state: status.state,
      activityCount: status.activities.length,
      ...(token ? { token } : {}),
      ...(status.reason ? { reason: status.reason } : {}),
    },
  };
}

export const handler = createTypedTool(
  schemaObject,
  resourceOperationLogic,
  getDefaultCommandExecutor,
);
