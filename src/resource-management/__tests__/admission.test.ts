import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createMockExecutor } from '../../test-utils/mock-executors.ts';
import { SimulatorResourceManager } from '../manager.ts';
import { resolveManagedWorktree } from '../worktree.ts';

it('rejects an admission whose worktree was replaced after target resolution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resource-admission-'));
  try {
    const root = join(directory, 'checkout');
    await mkdir(join(root, '.git'), { recursive: true });
    const executor = createMockExecutor({});
    const worktree = await resolveManagedWorktree(root, async (...args) => ({
      ...(await executor(...args)),
      output: `${args[0].at(-1) === '--show-toplevel' ? root : join(root, '.git')}\n`,
    }));
    const manager = await SimulatorResourceManager.open({
      stateRoot: join(directory, 'state'),
      maxActiveOperations: 1,
    });
    const simulatorId = randomUUID();
    await manager.bind(worktree, { deviceType: 'fixture', runtime: 'fixture' }, simulatorId);
    const lease = await manager.requestLease({
      requestId: randomUUID(),
      owner: { sessionId: randomUUID() },
      worktree,
    });
    await rename(root, join(directory, 'retired'));
    await mkdir(join(root, '.git'), { recursive: true });
    await expect(
      manager.startCall(
        lease,
        { generation: worktree.generation, simulatorId },
        {
          id: randomUUID(),
          kind: 'call',
          runtimeId: randomUUID(),
          pid: process.pid,
        },
      ),
    ).rejects.toThrow('generation changed');
    expect((await manager.end(lease)).state).toBe('released');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
