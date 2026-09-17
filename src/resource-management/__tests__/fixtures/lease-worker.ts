import {
  SimulatorResourceManager,
  type LeaseCredentials,
  type LeaseRequest,
  type OperationActivity,
  type SimulatorSpecification,
} from '../../manager.ts';
import type { ManagedWorktree } from '../../worktree.ts';

export type WorkerCommand =
  | {
      action: 'bind';
      worktree: ManagedWorktree;
      specification: SimulatorSpecification;
      simulatorId: string;
    }
  | { action: 'request'; request: LeaseRequest }
  | {
      action: 'provision';
      worktree: ManagedWorktree;
      specification: SimulatorSpecification;
      simulatorId: string;
    }
  | { action: 'complete-creation' }
  | { action: 'poll' | 'end' | 'cancel'; credentials: LeaseCredentials }
  | { action: 'status'; requestId: string }
  | {
      action: 'start';
      credentials: LeaseCredentials;
      target: { generation: string; simulatorId: string };
      activity: OperationActivity;
    }
  | { action: 'finish'; credentials: LeaseCredentials; activityId: string; runtimeId: string }
  | { action: 'helper'; credentials: LeaseCredentials; callId: string; activity: OperationActivity }
  | { action: 'block'; credentials: LeaseCredentials; reason: string };

const manager = await SimulatorResourceManager.open({
  stateRoot: process.argv[2],
  maxActiveOperations: Number(process.argv[3]),
});
let completeCreation: (() => void) | undefined;

async function run(command: WorkerCommand): Promise<unknown> {
  switch (command.action) {
    case 'provision':
      return manager.provision(command.worktree, command.specification, async () => {
        const completed = new Promise<void>((resolve) => {
          completeCreation = resolve;
        });
        process.send?.({ creating: true });
        await completed;
        return command.simulatorId;
      });
    case 'complete-creation':
      if (!completeCreation) throw new Error('No creation is pending');
      completeCreation();
      completeCreation = undefined;
      return null;
    case 'bind':
      return manager.bind(command.worktree, command.specification, command.simulatorId);
    case 'request':
      return manager.requestLease(command.request);
    case 'poll':
      return manager.poll(command.credentials);
    case 'end':
      return manager.end(command.credentials);
    case 'cancel':
      return manager.cancel(command.credentials);
    case 'status':
      return manager.getStatus(command.requestId);
    case 'start':
      return manager.startCall(command.credentials, command.target, command.activity);
    case 'finish':
      return manager.finishActivity(command.credentials, command.activityId, command.runtimeId);
    case 'helper':
      return manager.registerHelper(command.credentials, command.callId, command.activity);
    case 'block':
      return manager.block(command.credentials, command.reason);
  }
}

process.on('message', (message: { id: number; command: WorkerCommand }) => {
  void run(message.command).then(
    (result) => process.send?.({ id: message.id, result }),
    (error: unknown) =>
      process.send?.({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
process.on('disconnect', () => process.exit(0));
process.send?.({ ready: true });
