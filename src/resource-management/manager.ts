import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod';
import { containsPath, ResourceStore, type ResourceManagerOptions } from './store.ts';
import { worktreeGeneration, type ManagedWorktree } from './worktree.ts';

const id = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), 'Identity UUID must be lowercase');
const simulatorIdSchema = z.uuid().transform((value) => value.toLowerCase());
const generation = z.string().regex(/^[a-f0-9]{64}$/);
const worktreeSchema = z
  .object({ generation, root: z.string(), gitDir: z.string(), workspaceKey: z.string() })
  .strict();
const specificationSchema = z
  .object({ deviceType: z.string().min(1), runtime: z.string().min(1) })
  .strict();
const bindingSchema = z
  .object({
    version: z.literal(1),
    worktree: worktreeSchema,
    specification: specificationSchema,
    simulatorId: simulatorIdSchema,
  })
  .strict();
const provisioningSchema = z
  .object({
    version: z.literal(1),
    id,
    worktree: worktreeSchema,
    specification: specificationSchema,
    state: z.enum(['creating', 'created', 'blocked']),
    simulatorId: simulatorIdSchema.optional(),
  })
  .strict();
const ownerSchema = z.object({ sessionId: id }).strict();
const activitySchema = z
  .object({ id, kind: z.enum(['call', 'helper']), runtimeId: id, pid: z.number().int().positive() })
  .strict();
const legacyOperationSchema = z
  .object({
    version: z.literal(1),
    requestId: id,
    token: id,
    owner: ownerSchema,
    generation,
    simulatorId: simulatorIdSchema,
    sequence: z.number().int().positive(),
    state: z.enum(['waiting', 'active', 'closing', 'blocked', 'released', 'cancelled']),
    activities: z.array(activitySchema),
    completedActivities: z.array(activitySchema),
    reason: z.string().optional(),
  })
  .strict();
const currentOperationSchema = z
  .object({
    version: z.literal(2),
    requestId: id,
    token: id,
    owner: ownerSchema,
    generation,
    simulatorId: simulatorIdSchema,
    sequence: z.number().int().positive(),
    state: z.enum(['waiting', 'active', 'closing', 'blocked', 'released', 'cancelled']),
    activities: z.array(activitySchema),
    completedActivities: z
      .array(activitySchema)
      .max(1)
      .refine((entries) => entries.every((entry) => entry.kind === 'call')),
    reason: z.string().optional(),
  })
  .strict();
const operationSchema = z.union([currentOperationSchema, legacyOperationSchema]);
const completionSchema = z
  .object({
    requestId: id,
    owner: ownerSchema,
    activity: activitySchema,
  })
  .strict();

export type SimulatorSpecification = z.infer<typeof specificationSchema>;
export type SimulatorBinding = z.infer<typeof bindingSchema>;
export type SimulatorProvisioning = z.infer<typeof provisioningSchema>;
/** Must create a new device and resolve only after creation has definitively stopped. */
export type SimulatorCreator = (request: {
  name: string;
  specification: SimulatorSpecification;
}) => Promise<string>;
export type OperationOwner = z.infer<typeof ownerSchema>;
export type OperationActivity = z.infer<typeof activitySchema>;
type LegacyOperation = z.infer<typeof legacyOperationSchema>;
type CurrentOperation = z.infer<typeof currentOperationSchema>;
type Operation = LegacyOperation | CurrentOperation;
type CompletionReceipt = z.infer<typeof completionSchema>;
export type OperationStatus = Omit<Operation, 'token'>;
export interface LeaseCredentials {
  requestId: string;
  token: string;
  sessionId: string;
}
export interface LeaseRequest {
  requestId: string;
  owner: OperationOwner;
  worktree: ManagedWorktree;
}
export interface Lease extends LeaseCredentials {
  state: Operation['state'];
  simulatorId: string;
}

function operationPath(requestId: string): string {
  return `operations/${id.parse(requestId)}.json`;
}
function completionPath(requestId: string, activityId: string): string {
  return `completions/${id.parse(requestId)}.${id.parse(activityId)}.json`;
}
function bindingPath(value: string): string {
  return `bindings/${generation.parse(value)}.json`;
}
function provisioningPath(value: string): string {
  return `provisioning/${generation.parse(value)}.json`;
}
function holdsDevice(operation: Operation): boolean {
  return ['active', 'closing', 'blocked'].includes(operation.state);
}
function status(operation: Operation): OperationStatus {
  const { token: _token, ...result } = operation;
  return result;
}
function lease(operation: Operation): Lease {
  return {
    requestId: operation.requestId,
    token: operation.token,
    sessionId: operation.owner.sessionId,
    state: operation.state,
    simulatorId: operation.simulatorId,
  };
}

function activitiesMatch(left: OperationActivity, right: OperationActivity): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.runtimeId === right.runtimeId &&
    left.pid === right.pid
  );
}

/** Internal opt-in core; it does not provision devices or intercept existing tools. */
export class SimulatorResourceManager {
  private constructor(private readonly store: ResourceStore) {}

  static async open(options: ResourceManagerOptions): Promise<SimulatorResourceManager> {
    return new SimulatorResourceManager(await ResourceStore.open(options));
  }

  private async validateWorktree(worktree: ManagedWorktree): Promise<void> {
    worktreeSchema.parse(worktree);
    if (containsPath(worktree.root, this.store.root))
      throw new Error('Resource state cannot live inside a worktree');
    if ((await worktreeGeneration(worktree.root, worktree.gitDir)) !== worktree.generation) {
      throw new Error('Worktree generation changed');
    }
  }

  /** Internal binding boundary. Cannot override a pending or uncertain creation attempt. */
  async bind(
    worktree: ManagedWorktree,
    specification: SimulatorSpecification,
    simulatorId: string,
  ): Promise<SimulatorBinding> {
    const candidate = bindingSchema.parse({ version: 1, worktree, specification, simulatorId });
    return this.store.transaction(async () => {
      if (await this.store.read(provisioningPath(worktree.generation), provisioningSchema)) {
        throw new Error('Provisioning record exists; use provision or reconcile instead');
      }
      return this.bindInTransaction(candidate);
    });
  }

  private async bindInTransaction(candidate: SimulatorBinding): Promise<SimulatorBinding> {
    const { worktree, specification } = candidate;
    await this.validateWorktree(worktree);
    const bindings = await this.store.list('bindings', bindingSchema);
    const existing = bindings.find((entry) => entry.worktree.generation === worktree.generation);
    if (existing) {
      this.validateBindingLocation(existing, worktree);
      if (
        existing.simulatorId !== candidate.simulatorId ||
        existing.specification.deviceType !== specification.deviceType ||
        existing.specification.runtime !== specification.runtime
      ) {
        throw new Error(
          'Persistent Simulator binding conflicts with requested device or specification',
        );
      }
      return existing;
    }
    if (bindings.some((entry) => entry.simulatorId === candidate.simulatorId))
      throw new Error('Simulator is bound to another worktree generation');
    const provisioning = await this.store.list('provisioning', provisioningSchema);
    if (
      provisioning.some(
        (entry) =>
          entry.simulatorId === candidate.simulatorId &&
          entry.worktree.generation !== worktree.generation,
      )
    )
      throw new Error('Simulator is reserved by another provisioning attempt');
    await this.store.write(bindingPath(worktree.generation), candidate);
    return candidate;
  }

  /** Reserve durably before invoking an external creator, without holding the transaction lock. */
  async provision(
    worktree: ManagedWorktree,
    specification: SimulatorSpecification,
    create: SimulatorCreator,
    verifyCreated?: (simulatorId: string) => Promise<void>,
  ): Promise<SimulatorBinding> {
    const candidate = provisioningSchema.parse({
      version: 1,
      id: randomUUID(),
      worktree,
      specification,
      state: 'creating',
    });
    const path = provisioningPath(candidate.worktree.generation);
    const existing = await this.store.transaction(async () => {
      await this.validateWorktree(candidate.worktree);
      const binding = await this.store.read(
        bindingPath(candidate.worktree.generation),
        bindingSchema,
      );
      if (binding) {
        this.validateBindingLocation(binding, candidate.worktree);
        if (
          binding.specification.deviceType !== candidate.specification.deviceType ||
          binding.specification.runtime !== candidate.specification.runtime
        ) {
          throw new Error('Persistent Simulator binding conflicts with requested specification');
        }
        return binding;
      }
      if (await this.store.read(path, provisioningSchema)) {
        throw new Error('Simulator provisioning is in progress or requires reconciliation');
      }
      await this.store.write(path, candidate);
      return null;
    });
    if (existing) return existing;

    try {
      candidate.simulatorId = simulatorIdSchema.parse(
        await create({
          name: `XcodeBuildMCP-${candidate.id}`,
          specification: { ...candidate.specification },
        }),
      );
      await this.store.transaction(async () => {
        const current = await this.store.read(path, provisioningSchema);
        if (current?.id !== candidate.id || current.state !== 'creating') {
          throw new Error('Simulator provisioning ownership changed');
        }
        // Retain the observed UDID even if the worktree disappeared before binding commits.
        candidate.state = 'created';
        await this.store.write(path, candidate);
      });
      await verifyCreated?.(candidate.simulatorId);
      return await this.store.transaction(async () => {
        const current = await this.store.read(path, provisioningSchema);
        if (current?.id !== candidate.id || current.state !== 'created') {
          throw new Error('Simulator provisioning ownership changed');
        }
        return this.bindInTransaction(
          bindingSchema.parse({
            version: 1,
            worktree: candidate.worktree,
            specification: candidate.specification,
            simulatorId: candidate.simulatorId,
          }),
        );
      });
    } catch (error) {
      const committed = await this.store.transaction(async () => {
        const binding = await this.store.read(
          bindingPath(candidate.worktree.generation),
          bindingSchema,
        );
        if (candidate.simulatorId && binding?.simulatorId === candidate.simulatorId) return binding;
        const current = await this.store.read(path, provisioningSchema);
        if (current?.id === candidate.id) {
          candidate.state = 'blocked';
          await this.store.write(path, candidate);
        }
        return null;
      });
      // A committed binding wins a lost write acknowledgement; never create a replacement.
      if (committed) return committed;
      throw error;
    }
  }

  /** Retained creation evidence remains queryable even after the checkout is removed. */
  async getProvisioning(worktreeGenerationId: string): Promise<SimulatorProvisioning | null> {
    return this.store.transaction(() =>
      this.store.read(provisioningPath(worktreeGenerationId), provisioningSchema),
    );
  }

  async getBinding(worktreeGenerationId: string): Promise<SimulatorBinding | null> {
    return this.store.transaction(() =>
      this.store.read(bindingPath(worktreeGenerationId), bindingSchema),
    );
  }

  private validateBindingLocation(binding: SimulatorBinding, worktree: ManagedWorktree): void {
    if (binding.worktree.root !== worktree.root || binding.worktree.gitDir !== worktree.gitDir) {
      throw new Error('Worktree relocation requires reconciliation');
    }
  }

  private async schedule(): Promise<void> {
    const operations = await this.normalizeForScheduling(
      await this.store.list('operations', operationSchema),
    );
    const held = operations.filter(holdsDevice);
    const busyDevices = new Set(held.map((entry) => entry.simulatorId));
    let remaining = this.store.capacity - held.length;
    for (const candidate of operations
      .filter((entry) => entry.state === 'waiting')
      .sort((a, b) => a.sequence - b.sequence)) {
      if (remaining <= 0) break;
      if (busyDevices.has(candidate.simulatorId)) continue;
      candidate.state = 'active';
      await this.store.write(operationPath(candidate.requestId), candidate);
      busyDevices.add(candidate.simulatorId);
      remaining -= 1;
    }
  }

  /** requestId identifies one begin request across retries; sessionId identifies its caller. */
  async requestLease(request: LeaseRequest): Promise<Lease> {
    id.parse(request.requestId);
    ownerSchema.parse(request.owner);
    return this.store.transaction(async () => {
      await this.validateWorktree(request.worktree);
      const binding = await this.store.read(
        bindingPath(request.worktree.generation),
        bindingSchema,
      );
      if (!binding) throw new Error('Worktree has no Simulator binding');
      this.validateBindingLocation(binding, request.worktree);
      const previous = await this.store.read(operationPath(request.requestId), operationSchema);
      if (previous) {
        if (
          previous.owner.sessionId !== request.owner.sessionId ||
          previous.generation !== request.worktree.generation
        )
          throw new Error('Begin request identity conflicts');
      } else {
        const operations = await this.store.list('operations', operationSchema);
        const operation: Operation = {
          version: 2,
          requestId: request.requestId,
          token: randomUUID(),
          owner: request.owner,
          generation: request.worktree.generation,
          simulatorId: binding.simulatorId,
          sequence: operations.reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0) + 1,
          state: 'waiting',
          activities: [],
          completedActivities: [],
        };
        await this.store.write(operationPath(operation.requestId), operation);
      }
      await this.schedule();
      return lease(await this.readOperation(request.requestId));
    });
  }

  async acquire(
    request: LeaseRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Lease> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
      throw new Error('timeoutMs must be nonnegative and finite');
    options.signal?.throwIfAborted();
    const deadline = Date.now() + options.timeoutMs;
    let current = await this.requestLease(request);
    for (;;) {
      // A committed grant wins over a waiting deadline, including retries of an existing grant.
      if (current.state === 'active') return current;
      if (options.signal?.aborted || Date.now() > deadline) {
        current = await this.store.transaction(async () => {
          const operation = await this.authorize(current);
          if (operation.state === 'waiting') {
            operation.state = 'cancelled';
            await this.store.write(operationPath(operation.requestId), operation);
            await this.schedule();
          }
          return lease(operation);
        });
        if (current.state === 'active') return current;
        throw new Error(
          options.signal?.aborted ? 'Lease request cancelled' : 'Lease request timed out',
        );
      }
      if (current.state !== 'waiting') throw new Error(`Lease request is ${current.state}`);
      await delay(10);
      current = await this.poll(current);
    }
  }

  private async readOperation(requestId: string): Promise<Operation> {
    const operation = await this.store.read(operationPath(requestId), operationSchema);
    if (!operation) throw new Error('Unknown operation');
    return operation;
  }

  private async readCompletion(
    operation: Operation,
    activityId: string,
  ): Promise<CompletionReceipt | null> {
    const receipt = await this.store.read(
      completionPath(operation.requestId, activityId),
      completionSchema,
    );
    if (!receipt) return null;
    if (
      receipt.requestId !== operation.requestId ||
      receipt.owner.sessionId !== operation.owner.sessionId ||
      receipt.activity.id !== activityId
    ) {
      throw new Error('Completion receipt conflicts with operation identity');
    }
    return receipt;
  }

  private async ensureCompletion(operation: Operation, activity: OperationActivity): Promise<void> {
    const path = completionPath(operation.requestId, activity.id);
    const existing = await this.store.read(path, completionSchema);
    const expected: CompletionReceipt = {
      requestId: operation.requestId,
      owner: operation.owner,
      activity,
    };
    if (existing) {
      if (
        existing.requestId !== expected.requestId ||
        existing.owner.sessionId !== expected.owner.sessionId ||
        !activitiesMatch(existing.activity, expected.activity)
      ) {
        throw new Error('Completion receipt conflicts with operation identity');
      }
      return;
    }
    await this.store.write(path, expected);
  }

  private async migrateLegacyOperation(operation: LegacyOperation): Promise<CurrentOperation> {
    if (operation.activities.length > 0)
      throw new Error('Cannot migrate a legacy operation with active activities');
    for (const activity of operation.completedActivities) {
      await this.ensureCompletion(operation, activity);
    }
    const lastCall = operation.completedActivities.filter((entry) => entry.kind === 'call').at(-1);
    const migrated = currentOperationSchema.parse({
      ...operation,
      version: 2,
      completedActivities: lastCall ? [lastCall] : [],
    });
    await this.store.write(operationPath(operation.requestId), migrated);
    return migrated;
  }

  private async normalizeForScheduling(operations: Operation[]): Promise<Operation[]> {
    const normalized: Operation[] = [];
    for (const operation of operations) {
      if (operation.version === 1 && operation.activities.length === 0) {
        normalized.push(await this.migrateLegacyOperation(operation));
      } else {
        normalized.push(operation);
      }
    }
    return normalized;
  }

  private async authorize(credentials: LeaseCredentials): Promise<Operation> {
    const operation = await this.readOperation(credentials.requestId);
    if (
      operation.token !== credentials.token ||
      operation.owner.sessionId !== credentials.sessionId
    )
      throw new Error('Operation credentials do not match');
    return operation;
  }

  async poll(credentials: LeaseCredentials): Promise<Lease> {
    return this.store.transaction(async () => {
      await this.authorize(credentials);
      await this.schedule();
      return lease(await this.authorize(credentials));
    });
  }

  async getStatus(requestId: string): Promise<OperationStatus> {
    return this.store.transaction(async () => status(await this.readOperation(requestId)));
  }

  /** Reserve before starting work. A busy call returns false; the caller may wait or cancel. */
  async startCall(
    credentials: LeaseCredentials,
    target: { generation: string; simulatorId: string },
    activity: OperationActivity,
  ): Promise<boolean> {
    activitySchema.parse(activity);
    if (activity.kind !== 'call') throw new Error('Expected a call activity');
    return this.store.transaction(async () => {
      const operation = await this.authorize(credentials);
      if (operation.state !== 'active') throw new Error(`Operation is ${operation.state}`);
      const binding = await this.store.read(bindingPath(operation.generation), bindingSchema);
      if (!binding) throw new Error('Operation binding is missing');
      await this.validateWorktree(binding.worktree);
      if (
        target.generation !== operation.generation ||
        simulatorIdSchema.parse(target.simulatorId) !== operation.simulatorId
      )
        throw new Error('Effective target does not match the lease');
      if (await this.readCompletion(operation, activity.id))
        throw new Error('Activity identity already exists');
      if (
        [...operation.activities, ...operation.completedActivities].some(
          (entry) => entry.id === activity.id,
        )
      )
        throw new Error('Activity identity already exists');
      if (operation.activities.some((entry) => entry.kind === 'call')) return false;
      operation.activities.push(activity);
      await this.store.write(operationPath(operation.requestId), operation);
      return true;
    });
  }

  /** Register before spawning. The originating in-flight call may be draining after end. */
  async registerHelper(
    credentials: LeaseCredentials,
    callId: string,
    helper: OperationActivity,
  ): Promise<void> {
    activitySchema.parse(helper);
    if (helper.kind !== 'helper') throw new Error('Expected a helper activity');
    await this.store.transaction(async () => {
      const operation = await this.authorize(credentials);
      if (!['active', 'closing'].includes(operation.state))
        throw new Error(`Operation is ${operation.state}`);
      if (
        !operation.activities.some(
          (entry) =>
            entry.kind === 'call' && entry.id === callId && entry.runtimeId === helper.runtimeId,
        )
      )
        throw new Error('Helper requires its owning in-flight call');
      if (
        [...operation.activities, ...operation.completedActivities].some(
          (entry) => entry.id === helper.id,
        )
      )
        throw new Error('Activity identity already exists');
      if (await this.readCompletion(operation, helper.id))
        throw new Error('Activity identity already exists');
      operation.activities.push(helper);
      await this.store.write(operationPath(operation.requestId), operation);
    });
  }

  /** Only call after this runtime has observed all activity side effects and child work stopped. */
  async finishActivity(
    credentials: LeaseCredentials,
    activityId: string,
    runtimeId: string,
  ): Promise<OperationStatus> {
    return this.store.transaction(
      async () => {
        const operation = await this.authorize(credentials);
        const completed = operation.completedActivities.find((entry) => entry.id === activityId);
        if (completed) {
          if (completed.runtimeId !== runtimeId)
            throw new Error('Activity ownership does not match');
          const receipt = await this.readCompletion(operation, activityId);
          if (receipt && !activitiesMatch(receipt.activity, completed)) {
            throw new Error('Completion receipt conflicts with operation activity');
          }
          return status(operation);
        }
        const activity = operation.activities.find((entry) => entry.id === activityId);
        if (activity && activity.runtimeId !== runtimeId)
          throw new Error('Activity ownership does not match');
        const receipt = await this.readCompletion(operation, activityId);
        if (!activity) {
          if (receipt) {
            if (receipt.activity.runtimeId !== runtimeId)
              throw new Error('Activity ownership does not match');
            return status(operation);
          }
          throw new Error('Activity is not active');
        }
        if (receipt && !activitiesMatch(receipt.activity, activity)) {
          throw new Error('Completion receipt conflicts with operation activity');
        }
        await this.ensureCompletion(operation, activity);
        operation.activities = operation.activities.filter((entry) => entry.id !== activityId);
        if (operation.version === 1) operation.completedActivities.push(activity);
        else if (activity.kind === 'call') operation.completedActivities = [activity];
        if (operation.state === 'closing' && operation.activities.length === 0)
          operation.state = 'released';
        await this.store.write(operationPath(operation.requestId), operation);
        await this.schedule();
        return status(await this.readOperation(credentials.requestId));
      },
      { waitForLock: true },
    );
  }

  async end(credentials: LeaseCredentials): Promise<OperationStatus> {
    return this.close(credentials, false);
  }

  async cancel(credentials: LeaseCredentials): Promise<OperationStatus> {
    return this.close(credentials, true);
  }

  private async close(credentials: LeaseCredentials, cancel: boolean): Promise<OperationStatus> {
    return this.store.transaction(async () => {
      const operation = await this.authorize(credentials);
      if (operation.state === 'waiting') {
        if (!cancel) throw new Error('Cancel a waiting request instead of ending it');
        operation.state = 'cancelled';
      } else if (operation.state === 'blocked') {
        throw new Error(
          'Operation is blocked; end/cancel cannot recover it and no managed unblock action is available',
        );
      } else if (operation.state === 'active' || operation.state === 'closing') {
        operation.state = operation.activities.length ? 'closing' : 'released';
      }
      await this.store.write(operationPath(operation.requestId), operation);
      await this.schedule();
      return status(await this.readOperation(credentials.requestId));
    });
  }

  /** Loss of runtime supervision fences new calls. No TTL/PID-based recovery is permitted. */
  async block(credentials: LeaseCredentials, reason: string): Promise<void> {
    if (!reason.trim()) throw new Error('A blocking reason is required');
    await this.store.transaction(async () => {
      const operation = await this.authorize(credentials);
      if (!holdsDevice(operation)) throw new Error('Only a held operation can be blocked');
      operation.state = 'blocked';
      operation.reason = reason;
      await this.store.write(operationPath(operation.requestId), operation);
    });
  }
}
