import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { CommandExecutor } from '../utils/execution/index.ts';
import { workspaceKeyForRoot } from '../utils/workspace-identity.ts';

export interface ManagedWorktree {
  generation: string;
  root: string;
  gitDir: string;
  workspaceKey: string;
}

async function directoryIdentity(directory: string): Promise<string> {
  const info = await stat(directory, { bigint: true });
  if (!info.isDirectory() || info.birthtimeNs <= 0n || info.ino <= 0n) {
    throw new Error('Worktree identity requires directory inode and birth time');
  }
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

export async function worktreeGeneration(root: string, gitDir: string): Promise<string> {
  const identities = await Promise.all([directoryIdentity(root), directoryIdentity(gitDir)]);
  return createHash('sha256').update(identities.join('/')).digest('hex');
}

/** Git resolves nested working directories and linked worktrees; no marker is written to Git. */
export async function resolveManagedWorktree(
  cwd: string,
  executor: CommandExecutor,
): Promise<ManagedWorktree> {
  const paths: string[] = [];
  for (const option of ['--show-toplevel', '--absolute-git-dir']) {
    const response = await executor(
      ['git', '-C', cwd, 'rev-parse', option],
      'Worktree identity',
      false,
    );
    if (!response.success)
      throw new Error(`Cannot resolve worktree: ${response.error ?? response.output}`);
    const value = response.output.replace(/\r?\n$/, '');
    if (!value || /[\r\n]/.test(value)) throw new Error('Expected one Git directory path');
    paths.push(await realpath(value));
  }
  const [root, gitDir] = paths;
  return {
    root,
    gitDir,
    generation: await worktreeGeneration(root, gitDir),
    workspaceKey: workspaceKeyForRoot(root),
  };
}
