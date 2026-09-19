import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockExecutor } from '../../test-utils/mock-executors.ts';
import {
  SimulatorResourceManager,
  type Lease,
  type LeaseRequest,
  type OperationActivity,
  type OperationStatus,
  type SimulatorBinding,
} from '../manager.ts';
import { resolveManagedWorktree, type ManagedWorktree } from '../worktree.ts';
import type { WorkerCommand } from './fixtures/lease-worker.ts';
import { ResourceStore } from '../store.ts';

const specification = { deviceType: 'test-device-type', runtime: 'test-runtime' };
const workers: Worker[] = [];
let directory: string;
let stateRoot: string;
let worktree: ManagedWorktree;
let manager: SimulatorResourceManager;
let simulatorId: string;

class Worker {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private stderr = '';
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
  readonly creationStarted: Promise<void>;

  constructor() {
    // Real Node children intentionally exercise the filesystem protocol, never external device tools.
    this.child = fork(
      fileURLToPath(new URL('./fixtures/lease-worker.ts', import.meta.url)),
      [stateRoot, '2'],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.exited = once(this.child, 'exit').then(() => undefined);
    this.creationStarted = new Promise((resolve) => {
      this.child.on('message', (message: { creating?: boolean }) => {
        if (message.creating) resolve();
      });
    });
    this.ready = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.on(
        'message',
        (message: { ready?: boolean; id?: number; result?: unknown; error?: string }) => {
          if (message.ready) {
            resolve();
            return;
          }
          if (message.id === undefined) return;
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.result);
        },
      );
      this.child.once('exit', () => {
        const error = new Error(`Lease worker exited: ${this.stderr}`);
        reject(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      });
    });
    workers.push(this);
  }

  async send<T>(command: WorkerCommand): Promise<T> {
    await this.ready;
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.child.send({ id, command }, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.exited;
  }
}

async function identify(root: string): Promise<ManagedWorktree> {
  const executor = createMockExecutor({});
  // Fixtures use a separate Git directory but inject Git discovery; no git executable is launched.
  return resolveManagedWorktree(root, async (...args) => {
    const result = await executor(...args);
    const option = args[0].at(-1);
    if (option !== '--show-toplevel' && option !== '--absolute-git-dir') {
      throw new Error('Unexpected Git discovery command');
    }
    return { ...result, output: `${option === '--show-toplevel' ? root : join(root, '.git')}\n` };
  });
}

async function makeWorktree(name: string): Promise<ManagedWorktree> {
  const root = join(directory, name);
  await mkdir(join(root, '.git'), { recursive: true });
  return identify(root);
}

function request(target = worktree): LeaseRequest {
  return { requestId: randomUUID(), owner: { sessionId: randomUUID() }, worktree: target };
}

function activity(
  kind: 'call' | 'helper' = 'call',
  runtimeId: string = randomUUID(),
): OperationActivity {
  return { id: randomUUID(), kind, runtimeId, pid: process.pid };
}

function target(
  tree = worktree,
  device = simulatorId,
): { generation: string; simulatorId: string } {
  return { generation: tree.generation, simulatorId: device };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-manager-'));
  stateRoot = join(directory, 'state');
  worktree = await makeWorktree('checkout');
  simulatorId = randomUUID();
  manager = await SimulatorResourceManager.open({ stateRoot, maxActiveOperations: 2 });
  await manager.bind(worktree, specification, simulatorId);
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await rm(directory, { recursive: true, force: true });
});

describe('persistent identity and isolation', () => {
  it('resolves Git paths with injected commands and preserves binding after ordinary file edits', async () => {
    await writeFile(join(worktree.root, 'source.txt'), 'changed');
    const again = await identify(worktree.root);
    expect(again.generation).toBe(worktree.generation);
    expect(await manager.bind(again, specification, simulatorId)).toMatchObject({ simulatorId });
  });

  it('distinguishes same-path replacement while retaining the removed generation record', async () => {
    await rename(worktree.root, join(directory, 'old-checkout'));
    const replacement = await makeWorktree('checkout');
    expect(replacement.workspaceKey).toBe(worktree.workspaceKey);
    expect(replacement.generation).not.toBe(worktree.generation);
    await expect(manager.requestLease(request())).rejects.toThrow('generation changed');
    await expect(manager.bind(replacement, specification, simulatorId)).rejects.toThrow(
      'another worktree',
    );
    await manager.bind(replacement, specification, randomUUID());
    await rm(join(directory, 'old-checkout'), { recursive: true });
    expect(await manager.getBinding(worktree.generation)).toMatchObject({ simulatorId });
  });

  it('does not silently replace a bound specification or device', async () => {
    await expect(
      manager.bind(worktree, { ...specification, runtime: 'different' }, simulatorId),
    ).rejects.toThrow('conflicts');
    await expect(manager.bind(worktree, specification, randomUUID())).rejects.toThrow('conflicts');
  });

  it('requires reconciliation when a bound worktree moves', async () => {
    const movedRoot = join(directory, 'moved');
    await rename(worktree.root, movedRoot);
    const moved = await identify(movedRoot);
    expect(moved.generation).toBe(worktree.generation);
    await expect(manager.bind(moved, specification, simulatorId)).rejects.toThrow('relocation');
    await expect(manager.requestLease(request(moved))).rejects.toThrow('relocation');
  });

  it('treats UUID case variants as the same Simulator across independent binders', async () => {
    const firstTree = await makeWorktree('case-a');
    const secondTree = await makeWorktree('case-b');
    const device = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const outcomes = await Promise.allSettled(
      [new Worker(), new Worker()].map((worker, index) =>
        worker.send({
          action: 'bind',
          worktree: [firstTree, secondTree][index],
          specification,
          simulatorId: index === 0 ? device : device.toUpperCase(),
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toEqual(
      new Error('Simulator is bound to another worktree generation'),
    );
  });

  it('requires explicit consistent private storage outside the checkout', async () => {
    await expect(
      SimulatorResourceManager.open({ stateRoot: 'relative', maxActiveOperations: 2 }),
    ).rejects.toThrow('absolute');
    await expect(
      SimulatorResourceManager.open({ stateRoot, maxActiveOperations: 1 }),
    ).rejects.toThrow('same operation capacity');
    const nested = await SimulatorResourceManager.open({
      stateRoot: join(worktree.root, 'state'),
      maxActiveOperations: 2,
    });
    await expect(nested.bind(worktree, specification, simulatorId)).rejects.toThrow(
      'inside a worktree',
    );
  });

  it('fails on corrupt records rather than treating them as available', async () => {
    await writeFile(join(stateRoot, 'operations', `${randomUUID()}.json`), '{broken');
    await expect(manager.requestLease(request())).rejects.toThrow(SyntaxError);
  });
});

describe('dedicated-device provisioning', () => {
  it('creates once and reuses the persisted binding across manager instances', async () => {
    const tree = await makeWorktree('provision');
    const device = randomUUID();
    const create = vi.fn(async () => device.toUpperCase());
    const binding = await manager.provision(tree, specification, create);
    const reopened = await SimulatorResourceManager.open({ stateRoot, maxActiveOperations: 2 });
    expect(await reopened.provision(tree, specification, create)).toEqual(binding);
    expect(binding.simulatorId).toBe(device);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      name: expect.stringMatching(/^XcodeBuildMCP-[a-f0-9-]+$/),
      specification,
    });
    expect(await manager.getProvisioning(tree.generation)).toMatchObject({
      state: 'created',
      simulatorId: device,
    });
    await expect(
      reopened.provision(tree, { ...specification, runtime: 'different' }, create),
    ).rejects.toThrow('conflicts');
    expect(create).toHaveBeenCalledTimes(1);
    const first = await manager.requestLease(request(tree));
    await manager.end(first);
    expect(await reopened.requestLease(request(tree))).toMatchObject({
      state: 'active',
      simulatorId: device,
    });
  });

  it('retains uncertain creation and rejects retries and direct binding', async () => {
    const tree = await makeWorktree('uncertain');
    const create = vi.fn(async () => {
      throw new Error('Creation response lost');
    });
    await expect(manager.provision(tree, specification, create)).rejects.toThrow('response lost');
    expect(await manager.getProvisioning(tree.generation)).toMatchObject({ state: 'blocked' });
    await expect(manager.provision(tree, specification, create)).rejects.toThrow(
      'requires reconciliation',
    );
    await expect(manager.bind(tree, specification, randomUUID())).rejects.toThrow(
      'Provisioning record exists',
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(await manager.getBinding(tree.generation)).toBeNull();
  });

  it('retains the created UDID if the worktree disappears before commit', async () => {
    const tree = await makeWorktree('removed');
    const device = randomUUID();
    await expect(
      manager.provision(tree, specification, async () => {
        await rename(tree.root, join(directory, 'removed-checkout'));
        await makeWorktree('removed');
        return device;
      }),
    ).rejects.toThrow('generation changed');
    expect(await manager.getProvisioning(tree.generation)).toMatchObject({
      state: 'blocked',
      simulatorId: device,
    });
    expect(await manager.getBinding(tree.generation)).toBeNull();
    const replacement = await identify(tree.root);
    await expect(manager.bind(replacement, specification, device)).rejects.toThrow(
      'reserved by another provisioning attempt',
    );
  });

  it.each(['provisioning', 'bindings'])(
    'handles a lost acknowledgement after a %s write',
    async (recordType) => {
      const tree = await makeWorktree('lost-ack');
      const device = randomUUID();
      const create = vi.fn(async () => device);
      const write = ResourceStore.prototype.write;
      let injected = false;
      const spy = vi.spyOn(ResourceStore.prototype, 'write').mockImplementation(async function (
        this: ResourceStore,
        name,
        record,
      ) {
        await write.call(this, name, record);
        if (
          !injected &&
          name.startsWith(`${recordType}/`) &&
          (record as { simulatorId?: string }).simulatorId === device
        ) {
          injected = true;
          throw new Error('Write acknowledgement lost');
        }
      });
      try {
        if (recordType === 'bindings') {
          expect(await manager.provision(tree, specification, create)).toMatchObject({
            simulatorId: device,
          });
          expect(await manager.provision(tree, specification, create)).toMatchObject({
            simulatorId: device,
          });
        } else {
          await expect(manager.provision(tree, specification, create)).rejects.toThrow(
            'acknowledgement lost',
          );
          expect(await manager.getProvisioning(tree.generation)).toMatchObject({
            state: 'blocked',
            simulatorId: device,
          });
          expect(await manager.getBinding(tree.generation)).toBeNull();
          await expect(manager.provision(tree, specification, create)).rejects.toThrow(
            'requires reconciliation',
          );
        }
        expect(injected).toBe(true);
        expect(create).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('does not publish invalid or already bound device identities', async () => {
    for (const [device, message] of [
      ['invalid-uuid', 'Invalid UUID'],
      [simulatorId, 'Simulator is bound to another worktree generation'],
    ]) {
      const tree = await makeWorktree(randomUUID());
      await expect(manager.provision(tree, specification, async () => device)).rejects.toThrow(
        message,
      );
      expect(await manager.getBinding(tree.generation)).toBeNull();
      expect(await manager.getProvisioning(tree.generation)).toMatchObject({ state: 'blocked' });
    }
  });

  it('does not let the creator mutate the persisted specification', async () => {
    const tree = await makeWorktree('mutable');
    const result = await manager.provision(tree, specification, async (input) => {
      input.specification.runtime = 'different';
      return randomUUID();
    });
    expect(result.specification).toEqual(specification);
  });

  it('permits only one creator across processes and reuses its result while it stays alive', async () => {
    const tree = await makeWorktree('concurrent-create');
    const a = new Worker();
    const b = new Worker();
    const contenders = [a, b];
    await Promise.all(contenders.map((worker) => worker.ready));
    const creating = contenders.map((worker) =>
      worker.send<SimulatorBinding>({
        action: 'provision',
        worktree: tree,
        specification,
        simulatorId: randomUUID(),
      }),
    );
    const settled = Promise.allSettled(creating);
    const winner = await Promise.race(
      contenders.map(async (worker, index) => {
        await worker.creationStarted;
        return index;
      }),
    );
    await expect(creating[1 - winner]).rejects.toThrow('in progress');
    expect(await manager.getBinding(tree.generation)).toBeNull();
    // Unrelated lease work must not wait for an external creator's completion.
    expect((await manager.requestLease(request())).state).toBe('active');
    await contenders[winner].send({ action: 'complete-creation' });
    const binding = await creating[winner];
    expect((await settled).filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await contenders[1 - winner].send({
        action: 'provision',
        worktree: tree,
        specification,
        simulatorId: randomUUID(),
      }),
    ).toEqual(binding);
    expect(contenders[winner].child.exitCode).toBeNull();
  });

  it('does not reclaim a creation reservation after creator death or aging', async () => {
    const tree = await makeWorktree('dead-creator');
    const worker = new Worker();
    const creating = worker.send({
      action: 'provision',
      worktree: tree,
      specification,
      simulatorId: randomUUID(),
    });
    const rejected = expect(creating).rejects.toThrow('Lease worker exited');
    await worker.creationStarted;
    await worker.stop();
    await rejected;
    const oldTime = new Date('2000-01-01T00:00:00Z');
    await utimes(join(stateRoot, 'provisioning', `${tree.generation}.json`), oldTime, oldTime);
    const reopened = await SimulatorResourceManager.open({ stateRoot, maxActiveOperations: 2 });
    const create = vi.fn(async () => randomUUID());
    await expect(reopened.provision(tree, specification, create)).rejects.toThrow(
      'requires reconciliation',
    );
    expect(create).not.toHaveBeenCalled();
    expect(await reopened.getProvisioning(tree.generation)).toMatchObject({ state: 'creating' });
  });
});

describe('lease lifecycle', () => {
  it('deduplicates begin retries and redacts the token from status', async () => {
    const begin = request();
    const first = await manager.requestLease(begin);
    expect(await manager.requestLease(begin)).toEqual(first);
    expect(await manager.getStatus(first.requestId)).not.toHaveProperty('token');
    await expect(
      manager.requestLease({ ...begin, owner: { sessionId: randomUUID() } }),
    ).rejects.toThrow('conflicts');
    await manager.end(first);
    expect((await manager.requestLease(begin)).state).toBe('released');
  });

  it('keeps v2 completion history bounded while rejecting replayed activity IDs', async () => {
    const current = await manager.requestLease(request());
    const first = activity();
    const second = activity();

    await manager.startCall(current, target(), first);
    await manager.finishActivity(current, first.id, first.runtimeId);
    await manager.startCall(current, target(), second);
    await manager.finishActivity(current, second.id, second.runtimeId);
    await expect(manager.startCall(current, target(), first)).rejects.toThrow('already exists');

    const record = JSON.parse(
      await readFile(join(stateRoot, 'operations', `${current.requestId}.json`), 'utf8'),
    ) as {
      version: number;
      activities: OperationActivity[];
      completedActivities: OperationActivity[];
    };
    expect(record.version).toBe(2);
    expect(record.activities).toEqual([]);
    expect(record.completedActivities).toEqual([second]);

    const completionFiles = (await readdir(join(stateRoot, 'completions'))).filter((name) =>
      name.endsWith('.json'),
    );
    expect(completionFiles).toHaveLength(2);
    const firstReceipt = JSON.parse(
      await readFile(
        join(stateRoot, 'completions', `${current.requestId}.${first.id}.json`),
        'utf8',
      ),
    ) as { requestId: string; owner: { sessionId: string }; activity: OperationActivity };
    expect(firstReceipt).toEqual({
      requestId: current.requestId,
      owner: { sessionId: current.sessionId },
      activity: first,
    });
    expect(firstReceipt).not.toHaveProperty('token');
    expect((await manager.end(current)).state).toBe('released');
  });

  it('keeps the latest completed call when a helper finishes', async () => {
    const current = await manager.requestLease(request());
    const first = activity();
    const second = activity();
    const helper = activity('helper', second.runtimeId);

    await manager.startCall(current, target(), first);
    await manager.finishActivity(current, first.id, first.runtimeId);
    await manager.startCall(current, target(), second);
    await manager.registerHelper(current, second.id, helper);
    await manager.finishActivity(current, helper.id, helper.runtimeId);

    expect((await manager.getStatus(current.requestId)).completedActivities).toEqual([first]);
    expect((await manager.getStatus(current.requestId)).activities).toEqual([second]);

    await manager.finishActivity(current, second.id, second.runtimeId);
    expect((await manager.getStatus(current.requestId)).completedActivities).toEqual([second]);
    expect((await manager.end(current)).state).toBe('released');
  });

  it('fails closed on a conflicting historical receipt without changing a new in-flight activity', async () => {
    const current = await manager.requestLease(request());
    const first = activity();
    const second = activity();
    const third = activity();

    await manager.startCall(current, target(), first);
    await manager.finishActivity(current, first.id, first.runtimeId);
    await manager.startCall(current, target(), second);
    await manager.finishActivity(current, second.id, second.runtimeId);
    await manager.startCall(current, target(), third);

    await expect(manager.finishActivity(current, first.id, randomUUID())).rejects.toThrow(
      'Activity ownership does not match',
    );
    expect((await manager.getStatus(current.requestId)).activities).toEqual([third]);
    expect((await manager.finishActivity(current, first.id, first.runtimeId)).activities).toEqual([
      third,
    ]);

    await writeFile(
      join(stateRoot, 'completions', `${current.requestId}.${first.id}.json`),
      `${JSON.stringify({
        requestId: current.requestId,
        owner: { sessionId: randomUUID() },
        activity: first,
      })}\n`,
    );
    await expect(manager.finishActivity(current, first.id, first.runtimeId)).rejects.toThrow(
      'Completion receipt conflicts',
    );
    expect((await manager.getStatus(current.requestId)).activities).toEqual([third]);

    await manager.finishActivity(current, third.id, third.runtimeId);
    expect((await manager.end(current)).state).toBe('released');
  });

  it('leaves the header active when a receipt write fails before commit', async () => {
    const current = await manager.requestLease(request());
    const call = activity();
    await manager.startCall(current, target(), call);

    const write = ResourceStore.prototype.write;
    const spy = vi.spyOn(ResourceStore.prototype, 'write').mockImplementation(async function (
      this: ResourceStore,
      name,
      value,
    ) {
      if (name.startsWith('completions/')) throw new Error('Receipt write rejected');
      await write.call(this, name, value);
    });
    try {
      await expect(manager.finishActivity(current, call.id, call.runtimeId)).rejects.toThrow(
        'Receipt write rejected',
      );
    } finally {
      spy.mockRestore();
    }

    expect(
      (
        JSON.parse(
          await readFile(join(stateRoot, 'operations', `${current.requestId}.json`), 'utf8'),
        ) as { activities: OperationActivity[] }
      ).activities,
    ).toEqual([call]);
    await expect(
      readFile(join(stateRoot, 'completions', `${current.requestId}.${call.id}.json`), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await manager.finishActivity(current, call.id, call.runtimeId);
    expect((await manager.end(current)).state).toBe('released');
  });

  it('writes completion receipts before headers and resumes after a precommit header write failure', async () => {
    const current = await manager.requestLease(request());
    const call = activity();
    await manager.startCall(current, target(), call);

    const operationFile = `operations/${current.requestId}.json`;
    const write = ResourceStore.prototype.write;
    let failed = false;
    const spy = vi.spyOn(ResourceStore.prototype, 'write').mockImplementation(async function (
      this: ResourceStore,
      name,
      record,
    ) {
      if (
        !failed &&
        name === operationFile &&
        (record as { activities: unknown[] }).activities.length === 0
      ) {
        failed = true;
        throw new Error('Operation header write rejected');
      }
      await write.call(this, name, record);
    });
    try {
      await expect(manager.finishActivity(current, call.id, call.runtimeId)).rejects.toThrow(
        'header write rejected',
      );
    } finally {
      spy.mockRestore();
    }

    const unfinished = JSON.parse(
      await readFile(join(stateRoot, 'operations', `${current.requestId}.json`), 'utf8'),
    ) as { activities: OperationActivity[] };
    expect(unfinished.activities).toEqual([call]);
    await expect(
      readFile(join(stateRoot, 'completions', `${current.requestId}.${call.id}.json`), 'utf8'),
    ).resolves.toBeDefined();

    expect((await manager.finishActivity(current, call.id, call.runtimeId)).state).toBe('active');
    expect((await manager.getStatus(current.requestId)).activities).toEqual([]);
    expect((await manager.end(current)).state).toBe('released');
  });

  it('retries after a lost header acknowledgement without dropping closing work or waiters', async () => {
    const current = await manager.requestLease(request());
    const waiter = await manager.requestLease(request());
    const call = activity();
    const helper = activity('helper', call.runtimeId);
    await manager.startCall(current, target(), call);
    await manager.registerHelper(current, call.id, helper);
    await manager.end(current);

    const operationFile = `operations/${current.requestId}.json`;
    const write = ResourceStore.prototype.write;
    let lostAcknowledgement = false;
    const spy = vi.spyOn(ResourceStore.prototype, 'write').mockImplementation(async function (
      this: ResourceStore,
      name,
      record,
    ) {
      if (
        !lostAcknowledgement &&
        name === operationFile &&
        (record as { state: string; activities: OperationActivity[] }).state === 'closing' &&
        (record as { activities: OperationActivity[] }).activities.length === 1
      ) {
        await write.call(this, name, record);
        lostAcknowledgement = true;
        throw new Error('Operation header acknowledgement lost');
      }
      await write.call(this, name, record);
    });
    try {
      await expect(manager.finishActivity(current, call.id, call.runtimeId)).rejects.toThrow(
        'header acknowledgement lost',
      );
    } finally {
      spy.mockRestore();
    }

    expect((await manager.getStatus(current.requestId)).state).toBe('closing');
    expect((await manager.getStatus(current.requestId)).activities).toEqual([helper]);
    expect((await manager.finishActivity(current, call.id, call.runtimeId)).state).toBe('closing');
    await manager.finishActivity(current, helper.id, helper.runtimeId);
    expect((await manager.poll(waiter)).state).toBe('active');
    expect((await manager.end(waiter)).state).toBe('released');
  });

  it('keeps legacy active records at v1 until activities drain, then migrates them', async () => {
    const current = await manager.requestLease(request());
    const call = activity();
    const helper = activity('helper', call.runtimeId);
    await manager.startCall(current, target(), call);
    await manager.registerHelper(current, call.id, helper);

    const operationPath = join(stateRoot, 'operations', `${current.requestId}.json`);
    const record = JSON.parse(await readFile(operationPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      operationPath,
      `${JSON.stringify({ ...record, version: 1, completedActivities: [] })}\n`,
    );

    await expect(manager.poll(current)).resolves.toMatchObject({ state: 'active' });
    expect((JSON.parse(await readFile(operationPath, 'utf8')) as { version: number }).version).toBe(
      1,
    );

    await manager.finishActivity(current, call.id, call.runtimeId);
    const drainedCall = JSON.parse(await readFile(operationPath, 'utf8')) as {
      version: number;
      activities: OperationActivity[];
      completedActivities: OperationActivity[];
    };
    expect(drainedCall.version).toBe(1);
    expect(drainedCall.activities).toEqual([helper]);
    expect(drainedCall.completedActivities).toEqual([call]);

    await manager.finishActivity(current, helper.id, helper.runtimeId);
    const migrated = JSON.parse(await readFile(operationPath, 'utf8')) as {
      version: number;
      activities: OperationActivity[];
      completedActivities: OperationActivity[];
    };
    expect(migrated.version).toBe(2);
    expect(migrated.activities).toEqual([]);
    expect(migrated.completedActivities).toEqual([call]);
    expect(
      (await readdir(join(stateRoot, 'completions'))).filter((name) => name.endsWith('.json')),
    ).toHaveLength(2);
    expect((await manager.end(current)).state).toBe('released');
  });

  it('retries a partial legacy migration without rewriting committed receipts', async () => {
    const current = await manager.requestLease(request());
    const first = activity();
    const second = activity();
    const operationPath = join(stateRoot, 'operations', `${current.requestId}.json`);
    const record = JSON.parse(await readFile(operationPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      operationPath,
      `${JSON.stringify({ ...record, version: 1, activities: [], completedActivities: [first, second] })}\n`,
    );

    const write = ResourceStore.prototype.write;
    let failed = false;
    let firstReceiptWrites = 0;
    const firstReceipt = `completions/${current.requestId}.${first.id}.json`;
    const spy = vi.spyOn(ResourceStore.prototype, 'write').mockImplementation(async function (
      this: ResourceStore,
      name,
      value,
    ) {
      if (name === firstReceipt) firstReceiptWrites += 1;
      await write.call(this, name, value);
      if (!failed && name === firstReceipt) {
        failed = true;
        throw new Error('Completion receipt acknowledgement lost');
      }
    });
    try {
      await expect(manager.poll(current)).rejects.toThrow('receipt acknowledgement lost');
      expect(
        (JSON.parse(await readFile(operationPath, 'utf8')) as { version: number }).version,
      ).toBe(1);
      expect(firstReceiptWrites).toBe(1);
      expect(
        (await readdir(join(stateRoot, 'completions'))).filter((name) => name.endsWith('.json')),
      ).toHaveLength(1);
      await expect(manager.poll(current)).resolves.toMatchObject({ state: 'active' });
      const migrated = JSON.parse(await readFile(operationPath, 'utf8')) as {
        version: number;
        completedActivities: OperationActivity[];
      };
      expect(migrated.version).toBe(2);
      expect(migrated.completedActivities).toEqual([second]);
      expect(firstReceiptWrites).toBe(1);
      expect(
        (await readdir(join(stateRoot, 'completions'))).filter((name) => name.endsWith('.json')),
      ).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
    expect((await manager.end(current)).state).toBe('released');
  });

  it('fails closed when a legacy completion receipt has a conflicting owner', async () => {
    const current = await manager.requestLease(request());
    const completed = activity();
    const operationPath = join(stateRoot, 'operations', `${current.requestId}.json`);
    const record = JSON.parse(await readFile(operationPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      operationPath,
      `${JSON.stringify({ ...record, version: 1, activities: [], completedActivities: [completed] })}\n`,
    );
    await writeFile(
      join(stateRoot, 'completions', `${current.requestId}.${completed.id}.json`),
      `${JSON.stringify({
        requestId: current.requestId,
        owner: { sessionId: randomUUID() },
        activity: completed,
      })}\n`,
    );

    await expect(manager.poll(current)).rejects.toThrow('Completion receipt conflicts');
    expect((JSON.parse(await readFile(operationPath, 'utf8')) as { version: number }).version).toBe(
      1,
    );
  });

  it('persists completion receipts across manager processes and rejects cross-process replay', async () => {
    const current = await manager.requestLease(request());
    const worker = new Worker();
    const call = { ...activity(), pid: worker.child.pid! };
    const laterCall = { ...activity(), pid: worker.child.pid! };
    expect(
      await worker.send<boolean>({
        action: 'start',
        credentials: current,
        target: target(),
        activity: call,
      }),
    ).toBe(true);
    await worker.send({
      action: 'finish',
      credentials: current,
      activityId: call.id,
      runtimeId: call.runtimeId,
    });
    expect((await manager.getStatus(current.requestId)).completedActivities).toEqual([call]);
    await worker.send<boolean>({
      action: 'start',
      credentials: current,
      target: target(),
      activity: laterCall,
    });
    await worker.send({
      action: 'finish',
      credentials: current,
      activityId: laterCall.id,
      runtimeId: laterCall.runtimeId,
    });
    expect((await manager.getStatus(current.requestId)).completedActivities).toEqual([laterCall]);
    await expect(manager.startCall(current, target(), call)).rejects.toThrow('already exists');
    expect((await manager.getStatus(current.requestId)).activities).toEqual([]);
    expect((await manager.end(current)).state).toBe('released');
  });

  it('allows zero-wait acquisition and never cancels a previously granted begin retry', async () => {
    const begin = request();
    const current = await manager.acquire(begin, { timeoutMs: 0 });
    const call = activity();
    await manager.startCall(current, target(), call);
    expect(await manager.acquire(begin, { timeoutMs: 0 })).toEqual(current);
    expect((await manager.getStatus(current.requestId)).state).toBe('active');
  });

  it('returns committed credentials if abort races with delivery of a grant', async () => {
    const controller = new AbortController();
    const original = manager.requestLease.bind(manager);
    vi.spyOn(manager, 'requestLease').mockImplementationOnce(async (begin) => {
      const granted = await original(begin);
      controller.abort();
      return granted;
    });
    const current = await manager.acquire(request(), { timeoutMs: 0, signal: controller.signal });
    expect(current.state).toBe('active');
    expect((await manager.getStatus(current.requestId)).state).toBe('active');
    await manager.end(current);
  });

  it('retries the same begin after its committed result is lost', async () => {
    const begin = request();
    const original = manager.requestLease.bind(manager);
    vi.spyOn(manager, 'requestLease').mockImplementationOnce(async (input) => {
      await original(input);
      throw new Error('Result delivery lost');
    });
    await expect(manager.requestLease(begin)).rejects.toThrow('delivery lost');
    const recovered = await manager.requestLease(begin);
    expect(recovered.state).toBe('active');
    expect(
      (await readdir(join(stateRoot, 'operations'))).filter((name) => name.endsWith('.json')),
    ).toHaveLength(1);
  });

  it('drains calls and helpers before transfer and fences new calls during end', async () => {
    const first = await manager.requestLease(request());
    const waiting = await manager.requestLease(request());
    const call = activity();
    const helper = activity('helper', call.runtimeId);
    expect(await manager.startCall(first, target(), call)).toBe(true);
    expect((await manager.end(first)).state).toBe('closing');
    await manager.registerHelper(first, call.id, helper);
    await expect(manager.startCall(first, target(), activity())).rejects.toThrow('closing');
    await manager.finishActivity(first, call.id, call.runtimeId);
    expect((await manager.poll(waiting)).state).toBe('waiting');
    expect((await manager.finishActivity(first, helper.id, helper.runtimeId)).state).toBe(
      'released',
    );
    expect((await manager.poll(waiting)).state).toBe('active');
    expect((await manager.end(first)).state).toBe('released');
    expect((await manager.poll(waiting)).state).toBe('active');
  });

  it('rejects wrong credentials, effective targets, and activity owners', async () => {
    const current = await manager.requestLease(request());
    await expect(
      manager.startCall({ ...current, sessionId: randomUUID() }, target(), activity()),
    ).rejects.toThrow('credentials');
    await expect(
      manager.startCall({ ...current, token: randomUUID() }, target(), activity()),
    ).rejects.toThrow('credentials');
    await expect(
      manager.startCall(current, target(worktree, randomUUID()), activity()),
    ).rejects.toThrow('target');
    const call = activity();
    await manager.startCall(current, target(), call);
    await expect(manager.finishActivity(current, call.id, randomUUID())).rejects.toThrow(
      'ownership',
    );
    await manager.finishActivity(current, call.id, call.runtimeId);
    await manager.end(current);
    await expect(manager.startCall(current, target(), activity())).rejects.toThrow('released');
  });

  it('cancels queued requests, observes timeout, and does not seize an active lease', async () => {
    const current = await manager.requestLease(request());
    const queued = await manager.requestLease(request());
    expect((await manager.cancel(queued)).state).toBe('cancelled');
    const timed = request();
    await expect(manager.acquire(timed, { timeoutMs: 25 })).rejects.toThrow('timed out');
    expect((await manager.getStatus(timed.requestId)).state).toBe('cancelled');
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.acquire(request(), { timeoutMs: 100, signal: controller.signal }),
    ).rejects.toThrow();
    expect((await manager.poll(current)).state).toBe('active');
  });

  it('retains blocked ownership even after all tracked activities finish', async () => {
    const current = await manager.requestLease(request());
    const call = activity();
    await manager.startCall(current, target(), call);
    await manager.block(current, 'Lost supervision of child process');
    await manager.finishActivity(current, call.id, call.runtimeId);
    await expect(manager.end(current)).rejects.toThrow(
      'Operation is blocked; end/cancel cannot recover it',
    );
    await expect(manager.cancel(current)).rejects.toThrow(
      'Operation is blocked; end/cancel cannot recover it',
    );
    expect((await manager.getStatus(current.requestId)).state).toBe('blocked');
    expect((await manager.requestLease(request())).state).toBe('waiting');
  });

  it('does not let a delayed finish retry release a later activity', async () => {
    const current = await manager.requestLease(request());
    const first = activity();
    await manager.startCall(current, target(), first);
    await manager.finishActivity(current, first.id, first.runtimeId);
    await expect(manager.startCall(current, target(), first)).rejects.toThrow('already exists');
    const second = activity();
    await manager.startCall(current, target(), second);
    await manager.end(current);
    expect((await manager.finishActivity(current, first.id, first.runtimeId)).state).toBe(
      'closing',
    );
    expect((await manager.getStatus(current.requestId)).activities).toEqual([second]);
  });

  it('cancels an acquire that is already waiting without leaking a queue entry', async () => {
    await manager.requestLease(request());
    const next = request();
    const controller = new AbortController();
    const acquiring = manager.acquire(next, { timeoutMs: 5_000, signal: controller.signal });
    const assertion = expect(acquiring).rejects.toThrow('cancelled');
    await expect
      .poll(async () =>
        (await readdir(join(stateRoot, 'operations'))).includes(`${next.requestId}.json`),
      )
      .toBe(true);
    controller.abort();
    await assertion;
    expect((await manager.getStatus(next.requestId)).state).toBe('cancelled');
  });

  it('enforces host capacity independently of binding count', async () => {
    const secondTree = await makeWorktree('second');
    const thirdTree = await makeWorktree('third');
    await manager.bind(secondTree, specification, randomUUID());
    await manager.bind(thirdTree, specification, randomUUID());
    const first = await manager.requestLease(request());
    expect((await manager.requestLease(request(secondTree))).state).toBe('active');
    const third = await manager.requestLease(request(thirdTree));
    expect(third.state).toBe('waiting');
    await manager.end(first);
    expect((await manager.poll(third)).state).toBe('active');
  });
});

describe('independent processes', () => {
  it('arbitrates simultaneous begin and hands off while the previous process stays alive', async () => {
    const a = new Worker();
    const b = new Worker();
    const leases = await Promise.all([
      a.send<Lease>({ action: 'request', request: request() }),
      b.send<Lease>({ action: 'request', request: request() }),
    ]);
    expect(leases.map((entry) => entry.state).sort()).toEqual(['active', 'waiting']);
    const index = leases.findIndex((entry) => entry.state === 'active');
    const holder = [a, b][index];
    const next = [a, b][1 - index];
    await holder.send({ action: 'end', credentials: leases[index] });
    expect(holder.child.exitCode).toBeNull();
    expect(
      await next.send<Lease>({ action: 'poll', credentials: leases[1 - index] }),
    ).toMatchObject({ state: 'active', simulatorId });
  });

  it('serializes concurrent calls carrying the same token across processes', async () => {
    const current = await manager.requestLease(request());
    const a = new Worker();
    const b = new Worker();
    const calls = [activity(), activity()];
    const entered = await Promise.all(
      [a, b].map((worker, index) =>
        worker.send<boolean>({
          action: 'start',
          credentials: current,
          target: target(),
          activity: calls[index],
        }),
      ),
    );
    expect(entered.filter(Boolean)).toHaveLength(1);
    const winner = calls[entered.indexOf(true)];
    await manager.finishActivity(current, winner.id, winner.runtimeId);
    const loser = calls[entered.indexOf(false)];
    expect(await manager.startCall(current, target(), loser)).toBe(true);
  });

  it('orders end versus call entry without releasing in-flight activity', async () => {
    const current = await manager.requestLease(request());
    const waiting = await manager.requestLease(request());
    const a = new Worker();
    const b = new Worker();
    const call = activity();
    const [entry, ending] = await Promise.allSettled([
      a.send<boolean>({ action: 'start', credentials: current, target: target(), activity: call }),
      b.send<OperationStatus>({ action: 'end', credentials: current }),
    ]);
    expect(ending.status).toBe('fulfilled');
    if (entry.status === 'fulfilled') {
      expect(entry.value).toBe(true);
      expect((await manager.poll(waiting)).state).toBe('waiting');
      await manager.finishActivity(current, call.id, call.runtimeId);
    } else {
      expect(String(entry.reason)).toContain('released');
    }
    expect((await manager.poll(waiting)).state).toBe('active');
  });

  it('does not reclaim on owner process death or aged records, including surviving helper records', async () => {
    const a = new Worker();
    const b = new Worker();
    const current = await a.send<Lease>({ action: 'request', request: request() });
    const call = { ...activity(), pid: a.child.pid! };
    await a.send({ action: 'start', credentials: current, target: target(), activity: call });
    const helper = { ...activity('helper', call.runtimeId), pid: b.child.pid! };
    await a.send({ action: 'helper', credentials: current, callId: call.id, activity: helper });
    await a.stop();
    const oldTime = new Date('2000-01-01T00:00:00Z');
    await utimes(join(stateRoot, 'operations', `${current.requestId}.json`), oldTime, oldTime);
    const waiting = await b.send<Lease>({ action: 'request', request: request() });
    expect(waiting.state).toBe('waiting');
    const record = JSON.parse(
      await readFile(join(stateRoot, 'operations', `${current.requestId}.json`), 'utf8'),
    ) as { activities: OperationActivity[] };
    expect(record.activities).toHaveLength(2);
    // No clock or expiry participates in scheduling; persisting/reopening never infers quiescence.
    const reopened = await SimulatorResourceManager.open({ stateRoot, maxActiveOperations: 2 });
    expect((await reopened.poll(waiting)).state).toBe('waiting');
    expect(b.child.exitCode).toBeNull();
  });

  it('prevents concurrent binding of one Simulator to two worktrees', async () => {
    const firstTree = await makeWorktree('binding-a');
    const secondTree = await makeWorktree('binding-b');
    const device = randomUUID();
    const outcomes = await Promise.allSettled(
      [new Worker(), new Worker()].map((worker, index) =>
        worker.send({
          action: 'bind',
          worktree: [firstTree, secondTree][index],
          specification,
          simulatorId: device,
        }),
      ),
    );
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find((entry) => entry.status === 'rejected');
    expect(rejected?.reason).toEqual(
      new Error('Simulator is bound to another worktree generation'),
    );
    expect(
      (await readdir(join(stateRoot, 'bindings'))).filter((entry) => entry.endsWith('.json')),
    ).toHaveLength(2);
  });

  it('lets different worktrees operate concurrently while preserving FIFO on a busy device', async () => {
    const other = await makeWorktree('parallel');
    const otherDevice = randomUUID();
    await manager.bind(other, specification, otherDevice);
    const a = new Worker();
    const b = new Worker();
    const [first, second] = await Promise.all([
      a.send<Lease>({ action: 'request', request: request() }),
      b.send<Lease>({ action: 'request', request: request(other) }),
    ]);
    expect([first.state, second.state]).toEqual(['active', 'active']);
    expect(first.simulatorId).not.toBe(second.simulatorId);
    const earlier = await b.send<Lease>({ action: 'request', request: request() });
    const later = await b.send<Lease>({ action: 'request', request: request() });
    await a.send({ action: 'end', credentials: first });
    expect((await manager.poll(earlier)).state).toBe('active');
    expect((await manager.poll(later)).state).toBe('waiting');
  });
});
