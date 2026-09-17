import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockExecutor } from '../../test-utils/mock-executors.ts';
import { FS_LOCK_OWNER_FILE, tryAcquireFsLock, type AcquiredFsLock } from '../../utils/fs-lock.ts';
import { SimulatorResourceManager, type LeaseRequest, type OperationActivity } from '../manager.ts';
import { resolveManagedWorktree, type ManagedWorktree } from '../worktree.ts';

const specification = { deviceType: 'test-device-type', runtime: 'test-runtime' };
let directory: string;
let stateRoot: string;
let manager: SimulatorResourceManager;
let firstWorktree: ManagedWorktree;
let secondWorktree: ManagedWorktree;
let firstSimulator: string;
let secondSimulator: string;

async function identify(root: string): Promise<ManagedWorktree> {
  const executor = createMockExecutor({});
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

function request(worktree: ManagedWorktree): LeaseRequest {
  return { requestId: randomUUID(), owner: { sessionId: randomUUID() }, worktree };
}

function activity(): OperationActivity {
  return { id: randomUUID(), kind: 'call', runtimeId: randomUUID(), pid: process.pid };
}

async function holdRegistryLock(): Promise<AcquiredFsLock> {
  const lock = await tryAcquireFsLock({
    lockDir: join(stateRoot, 'registry.lock'),
    purpose: 'resource-registry',
    leaseMs: 30_000,
  });
  if (!lock) throw new Error('Unable to hold the registry lock for the fixture');
  return lock;
}

async function waitForDateCalls(calls: () => number, minimum: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      if (interval) clearInterval(interval);
      reject(new Error(`Expected repeated lock attempts, saw ${calls()} Date.now calls`));
    }, 1_000);
    interval = setInterval(() => {
      if (calls() >= minimum) {
        clearTimeout(timeout);
        if (interval) clearInterval(interval);
        resolve();
      }
    }, 1);
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-manager-completion-lock-'));
  stateRoot = join(directory, 'state');
  firstWorktree = await makeWorktree('first');
  secondWorktree = await makeWorktree('second');
  firstSimulator = randomUUID();
  secondSimulator = randomUUID();
  manager = await SimulatorResourceManager.open({ stateRoot, maxActiveOperations: 1 });
  await manager.bind(firstWorktree, specification, firstSimulator);
  await manager.bind(secondWorktree, specification, secondSimulator);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('SimulatorResourceManager completion lock waiting', () => {
  it('keeps a closing activity until the live lock is released after its lease deadline', async () => {
    const current = await manager.requestLease(request(firstWorktree));
    const waiting = await manager.requestLease(request(secondWorktree));
    expect(waiting.state).toBe('waiting');

    const call = activity();
    expect(
      await manager.startCall(
        current,
        { generation: firstWorktree.generation, simulatorId: firstSimulator },
        call,
      ),
    ).toBe(true);
    expect((await manager.end(current)).state).toBe('closing');

    const held = await holdRegistryLock();
    const realNow = Date.now();
    const now = vi.spyOn(Date, 'now');
    let calls = 0;
    now.mockImplementation(() => realNow + (calls++ === 0 ? 0 : 30_001));
    let settled = false;
    const pending = manager.finishActivity(current, call.id, call.runtimeId).then(
      (result) => {
        settled = true;
        return result;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );

    try {
      await waitForDateCalls(() => calls, 2);
      expect(settled).toBe(false);
      const owner = JSON.parse(
        await readFile(join(stateRoot, 'registry.lock', FS_LOCK_OWNER_FILE), 'utf8'),
      ) as { token: string; pid: number };
      expect(owner).toMatchObject({ token: held.owner.token, pid: process.pid });
      const operation = JSON.parse(
        await readFile(join(stateRoot, 'operations', `${current.requestId}.json`), 'utf8'),
      ) as { state: string; activities: OperationActivity[] };
      expect(operation).toMatchObject({ state: 'closing', activities: [call] });

      await held.release();
      await expect(pending).resolves.toMatchObject({ state: 'released' });
      expect((await manager.poll(waiting)).state).toBe('active');
      const completed = JSON.parse(
        await readFile(join(stateRoot, 'operations', `${current.requestId}.json`), 'utf8'),
      ) as { state: string; activities: OperationActivity[] };
      expect(completed).toMatchObject({ state: 'released', activities: [] });
    } finally {
      now.mockRestore();
      await held.release();
      await pending.catch(() => {});
    }
  });
});
