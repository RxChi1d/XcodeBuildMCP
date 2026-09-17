import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  ensureSocketDir,
  getSocketPath,
  resolveWorkspaceRoot,
  setDaemonRunDirOverrideForTests,
} from '../socket-path.ts';
import { resourceEnvironment } from '../../resource-management/environment.ts';
import { shortWorkspaceHash, workspaceKeyForRoot } from '../../utils/workspace-identity.ts';

let tempDir: string;

describe('ensureSocketDir', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'xcodebuildmcp-socket-path-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a private socket directory', () => {
    const socketPath = path.join(tempDir, 'daemon', 'd.sock');

    ensureSocketDir(socketPath);

    expect(existsSync(path.dirname(socketPath))).toBe(true);
    expect(statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
  });

  it('tightens permissions on an existing socket directory owned by the current user', () => {
    const dir = path.join(tempDir, 'daemon');
    const socketPath = path.join(dir, 'd.sock');
    ensureSocketDir(socketPath);
    chmodSync(dir, 0o755);

    ensureSocketDir(socketPath);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('rejects symlink socket directories', () => {
    const targetDir = path.join(tempDir, 'target');
    const linkDir = path.join(tempDir, 'daemon');
    ensureSocketDir(path.join(targetDir, 'placeholder.sock'));
    symlinkSync(targetDir, linkDir);

    expect(() => ensureSocketDir(path.join(linkDir, 'd.sock'))).toThrow(/cannot be a symlink/u);
  });

  it('rejects non-directory socket path parents', () => {
    const filePath = path.join(tempDir, 'daemon');
    writeFileSync(filePath, 'not a directory');

    expect(() => ensureSocketDir(path.join(filePath, 'd.sock'))).toThrow(/not a directory/u);
  });
});

describe('getSocketPath environment propagation', () => {
  const environmentKeys = [
    'XCODEBUILDMCP_OPERATION_STATE_ROOT',
    'XCODEBUILDMCP_OPERATION_CAPACITY',
    'XCODEBUILDMCP_SOCKET',
  ] as const;
  const originalEnvironment = new Map<string, string | undefined>();
  let daemonRoot: string;
  let workspaceRoot: string;
  let otherWorkspaceRoot: string;

  beforeEach(() => {
    daemonRoot = mkdtempSync(path.join(tmpdir(), 'xcodebuildmcp-socket-run-'));
    workspaceRoot = mkdtempSync(path.join(tmpdir(), 'xcodebuildmcp-workspace-'));
    otherWorkspaceRoot = mkdtempSync(path.join(tmpdir(), 'xcodebuildmcp-workspace-'));
    setDaemonRunDirOverrideForTests(daemonRoot);
    for (const key of environmentKeys) {
      originalEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    setDaemonRunDirOverrideForTests(null);
    rmSync(daemonRoot, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(otherWorkspaceRoot, { recursive: true, force: true });
    for (const key of environmentKeys) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnvironment.clear();
  });

  function managedEnvironment(stateRoot: string): NodeJS.ProcessEnv {
    return {
      XCODEBUILDMCP_OPERATION_STATE_ROOT: stateRoot,
      XCODEBUILDMCP_OPERATION_CAPACITY: '2',
    };
  }

  function expectedManagedSocket(root: string, env: NodeJS.ProcessEnv): string {
    const managed = resourceEnvironment(env);
    if (!managed) throw new Error('Expected managed environment');
    const key = workspaceKeyForRoot(resolveWorkspaceRoot({ cwd: root }));
    return path.join(
      daemonRoot,
      `xbm-r-${shortWorkspaceHash(`${managed.namespace}:${key}`)}`,
      'd.sock',
    );
  }

  function expectedOrdinarySocket(root: string): string {
    const key = workspaceKeyForRoot(resolveWorkspaceRoot({ cwd: root }));
    const suffix = key.match(/-([a-f0-9]{12})$/u)?.[1] ?? shortWorkspaceHash(key);
    return path.join(daemonRoot, `xcodebuildmcp-${suffix}`, 'd.sock');
  }

  it('uses the explicit managed env when process.env is ordinary', () => {
    const env = managedEnvironment(path.join(workspaceRoot, 'state'));

    const socket = getSocketPath({ cwd: workspaceRoot, env });

    expect(socket).toBe(expectedManagedSocket(workspaceRoot, env));
    expect(socket).not.toBe(expectedOrdinarySocket(workspaceRoot));
    expect(getSocketPath({ cwd: otherWorkspaceRoot, env })).not.toBe(socket);
  });

  it('uses the explicit ordinary env when process.env is managed', () => {
    const managed = managedEnvironment(path.join(workspaceRoot, 'state'));
    for (const [key, value] of Object.entries(managed)) process.env[key] = value;

    const socket = getSocketPath({ cwd: workspaceRoot, env: {} });

    expect(socket).toBe(expectedOrdinarySocket(workspaceRoot));
  });

  it('returns an ordinary explicit override before resolving workspace context', () => {
    const socket = path.join(daemonRoot, 'explicit.sock');
    const options = {
      env: { XCODEBUILDMCP_SOCKET: socket },
      get projectConfigPath(): string {
        throw new Error('workspace resolution should not run');
      },
    };

    expect(getSocketPath(options)).toBe(socket);
  });

  it('validates explicit managed socket overrides against the same env and workspace', () => {
    const env = managedEnvironment(path.join(workspaceRoot, 'state'));
    const expected = expectedManagedSocket(workspaceRoot, env);

    expect(
      getSocketPath({
        cwd: workspaceRoot,
        env: { ...env, XCODEBUILDMCP_SOCKET: expected },
      }),
    ).toBe(expected);
    expect(() =>
      getSocketPath({
        cwd: workspaceRoot,
        env: { ...env, XCODEBUILDMCP_SOCKET: path.join(daemonRoot, 'foreign.sock') },
      }),
    ).toThrow('isolated');
    expect(() =>
      getSocketPath({
        cwd: workspaceRoot,
        env: { ...env, XCODEBUILDMCP_SOCKET: expectedManagedSocket(otherWorkspaceRoot, env) },
      }),
    ).toThrow('isolated');

    const otherEnvironment = managedEnvironment(path.join(otherWorkspaceRoot, 'state'));
    const otherNamespaceSocket = expectedManagedSocket(workspaceRoot, otherEnvironment);
    expect(otherNamespaceSocket).not.toBe(expected);
    expect(() =>
      getSocketPath({
        cwd: workspaceRoot,
        env: { ...env, XCODEBUILDMCP_SOCKET: otherNamespaceSocket },
      }),
    ).toThrow('isolated');
  });
});
