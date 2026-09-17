import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { ResourceManagerOptions } from './store.ts';

export interface ResourceEnvironment extends ResourceManagerOptions {
  namespace: string;
}

/** Explicit opt-in only. Both values must be identical in every participating process. */
export function resourceEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ResourceEnvironment | undefined {
  const root = env.XCODEBUILDMCP_OPERATION_STATE_ROOT;
  const capacity = env.XCODEBUILDMCP_OPERATION_CAPACITY;
  if (root === undefined && capacity === undefined) return undefined;
  if (!root || !isAbsolute(root) || !capacity || !/^[1-9][0-9]*$/.test(capacity)) {
    throw new Error(
      'Managed resources require an absolute OPERATION_STATE_ROOT and positive OPERATION_CAPACITY',
    );
  }
  const maxActiveOperations = Number(capacity);
  if (!Number.isSafeInteger(maxActiveOperations)) throw new Error('Invalid resource capacity');
  const stateRoot = resolve(root);
  const namespace = createHash('sha256').update(`${stateRoot}\n${capacity}`).digest('hex');
  return { stateRoot, maxActiveOperations, namespace };
}

export function assertResourceNamespace(namespace: unknown): void {
  const expected = resourceEnvironment()?.namespace;
  if (namespace !== expected) throw new Error('Resource-management namespace mismatch');
}
