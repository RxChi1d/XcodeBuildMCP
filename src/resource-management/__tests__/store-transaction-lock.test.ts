import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FS_LOCK_OWNER_FILE, tryAcquireFsLock, type AcquiredFsLock } from '../../utils/fs-lock.ts';
import { ResourceStore } from '../store.ts';

let directory: string;
let store: ResourceStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-store-lock-'));
  store = await ResourceStore.open({
    stateRoot: join(directory, 'state'),
    maxActiveOperations: 1,
  });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function holdRegistryLock(): Promise<AcquiredFsLock> {
  const lock = await tryAcquireFsLock({
    lockDir: join(store.root, 'registry.lock'),
    purpose: 'resource-registry',
    leaseMs: 30_000,
  });
  if (!lock) throw new Error('Unable to hold the registry lock for the fixture');
  return lock;
}

describe('ResourceStore transaction lock waiting', () => {
  it('keeps the default transaction deadline without invoking the callback', async () => {
    const held = await holdRegistryLock();
    const realNow = Date.now();
    const now = vi.spyOn(Date, 'now');
    let calls = 0;
    now.mockImplementation(() => realNow + (calls++ === 0 ? 0 : 10_001));
    const callback = vi.fn(async () => 'finished');

    try {
      await expect(store.transaction(callback)).rejects.toThrow('timed out');
      expect(callback).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      await held.release();
    }
  });

  it('waits for a live lock without stealing it, then completes the pending activity', async () => {
    const held = await holdRegistryLock();
    const activityPath = 'operations/activity.json';
    await store.write(activityPath, { state: 'active' });
    const callback = vi.fn(async () => {
      await store.write(activityPath, { state: 'finished' });
      return 'finished';
    });

    const realNow = Date.now();
    const now = vi.spyOn(Date, 'now');
    let calls = 0;
    now.mockImplementation(() => realNow + (calls++ === 0 ? 0 : 30_001));
    const pending = store.transaction(callback, { waitForLock: true });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(interval);
          reject(new Error(`Expected repeated lock attempts, saw ${calls} Date.now calls`));
        }, 1_000);
        const interval = setInterval(() => {
          if (calls >= 3) {
            clearTimeout(timeout);
            clearInterval(interval);
            resolve();
          }
        }, 1);
      });
      expect(callback).not.toHaveBeenCalled();
      const owner = JSON.parse(
        await readFile(join(store.root, 'registry.lock', FS_LOCK_OWNER_FILE), 'utf8'),
      ) as { token: string };
      expect(owner.token).toBe(held.owner.token);
      expect(JSON.parse(await readFile(join(store.root, activityPath), 'utf8'))).toEqual({
        state: 'active',
      });

      await held.release();
      await expect(pending).resolves.toBe('finished');
      expect(callback).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(join(store.root, activityPath), 'utf8'))).toEqual({
        state: 'finished',
      });
    } finally {
      now.mockRestore();
      await held.release();
      await pending.catch(() => {});
    }
  });
});
