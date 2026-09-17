import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveWorkspaceRoot,
  shortWorkspaceHash,
  workspaceKeyForRoot,
  resolveWorkspaceIdentity,
} from '../utils/workspace-identity.ts';
import { getWorkspaceFilesystemLayout } from '../utils/log-paths.ts';
import { resourceEnvironment } from '../resource-management/environment.ts';
import { getRuntimeInstance } from '../utils/runtime-instance.ts';

export { resolveWorkspaceRoot, workspaceKeyForRoot, resolveWorkspaceIdentity };

let daemonRunDirOverrideForTests: string | null = null;

function compactWorkspaceKey(workspaceKey: string): string {
  const hashSuffix = workspaceKey.match(/-([a-f0-9]{12})$/u)?.[1];
  return hashSuffix ?? shortWorkspaceHash(workspaceKey);
}

export function daemonRunDir(): string {
  return daemonRunDirOverrideForTests ?? tmpdir();
}

export function setDaemonRunDirOverrideForTests(dir: string | null): void {
  daemonRunDirOverrideForTests = dir;
}

export function daemonDirForWorkspaceKey(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const managed = resourceEnvironment(env);
  if (managed) {
    return join(daemonRunDir(), `xbm-r-${shortWorkspaceHash(`${managed.namespace}:${key}`)}`);
  }
  return join(daemonRunDir(), `xcodebuildmcp-${compactWorkspaceKey(key)}`);
}

export function assertManagedSocketPath(
  socketPath: string,
  workspaceRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!resourceEnvironment(env)) return;
  const key =
    workspaceRoot === undefined
      ? getRuntimeInstance().workspaceKey
      : workspaceKeyForRoot(workspaceRoot);
  if (socketPath !== join(daemonDirForWorkspaceKey(key, env), 'd.sock')) {
    throw new Error('Managed resources require the isolated workspace daemon socket');
  }
}

export function socketPathForWorkspaceRoot(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = workspaceKeyForRoot(workspaceRoot);
  return join(daemonDirForWorkspaceKey(key, env), 'd.sock');
}

export function registryPathForWorkspaceKey(key: string): string {
  return join(getWorkspaceFilesystemLayout(key).state, 'daemon', 'daemon.json');
}

export function logPathForWorkspaceKey(key: string): string {
  return join(getWorkspaceFilesystemLayout(key).logs, 'daemon.log');
}

export interface GetSocketPathOptions {
  cwd?: string;
  projectConfigPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function getSocketPath(opts?: GetSocketPathOptions): string {
  const env = opts?.env ?? process.env;
  if (env.XCODEBUILDMCP_SOCKET && !resourceEnvironment(env)) {
    return env.XCODEBUILDMCP_SOCKET;
  }

  const cwd = opts?.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot({
    cwd,
    projectConfigPath: opts?.projectConfigPath,
  });

  if (env.XCODEBUILDMCP_SOCKET) {
    assertManagedSocketPath(env.XCODEBUILDMCP_SOCKET, workspaceRoot, env);
    return env.XCODEBUILDMCP_SOCKET;
  }

  return socketPathForWorkspaceRoot(workspaceRoot, env);
}

function validateSocketDir(dir: string): void {
  const linkStat = lstatSync(dir);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Daemon socket directory cannot be a symlink: ${dir}`);
  }

  const stat = statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`Daemon socket path parent is not a directory: ${dir}`);
  }

  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Daemon socket directory is not owned by the current user: ${dir}`);
  }

  if ((stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
}

export function ensureSocketDir(socketPath: string): void {
  const dir = dirname(socketPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  validateSocketDir(dir);
}

export function removeStaleSocket(socketPath: string): void {
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }
}

/**
 * Get the daemon socket path for the current workspace context.
 * @deprecated Use getSocketPath() with explicit workspace context instead.
 */
export function defaultSocketPath(): string {
  return getSocketPath();
}
