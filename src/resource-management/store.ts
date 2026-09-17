import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod';
import { tryAcquireFsLock } from '../utils/fs-lock.ts';

export function containsPath(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

export interface ResourceManagerOptions {
  /** Explicit private directory outside checkouts and the installed tool's storage. */
  stateRoot: string;
  maxActiveOperations: number;
}

const configurationSchema = z
  .object({ version: z.literal(1), maxActiveOperations: z.number().int().positive() })
  .strict();

/** Registry transactions are bounded by default. Operation ownership lives in durable records. */
export class ResourceStore {
  private constructor(
    readonly root: string,
    readonly capacity: number,
  ) {}

  static async open(options: ResourceManagerOptions): Promise<ResourceStore> {
    if (!isAbsolute(options.stateRoot)) throw new Error('stateRoot must be absolute');
    const configuration = configurationSchema.parse({
      version: 1,
      maxActiveOperations: options.maxActiveOperations,
    });
    const installedRoot = join(homedir(), 'Library', 'Developer', 'XcodeBuildMCP');
    if (
      containsPath(options.stateRoot, installedRoot) ||
      containsPath(installedRoot, options.stateRoot)
    ) {
      throw new Error('Resource state must be isolated from installed tool storage');
    }
    await mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(options.stateRoot);
    const info = await lstat(options.stateRoot);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    ) {
      throw new Error('Resource state must be a private directory owned by the current user');
    }
    if (containsPath(root, installedRoot) || containsPath(installedRoot, root)) {
      throw new Error('Resource state resolves to installed tool storage');
    }
    const store = new ResourceStore(root, configuration.maxActiveOperations);
    await store.transaction(async () => {
      const previous = await store.read('configuration.json', configurationSchema);
      if (previous && previous.maxActiveOperations !== configuration.maxActiveOperations) {
        throw new Error('All participants must use the same operation capacity');
      }
      if (!previous) await store.write('configuration.json', configuration);
      for (const directory of ['bindings', 'operations', 'provisioning', 'completions']) {
        await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
      }
    });
    return store;
  }

  async transaction<T>(
    callback: () => Promise<T>,
    options: { waitForLock?: boolean } = {},
  ): Promise<T> {
    const deadline = options.waitForLock ? Number.POSITIVE_INFINITY : Date.now() + 10_000;
    do {
      const lock = await tryAcquireFsLock({
        lockDir: join(this.root, 'registry.lock'),
        purpose: 'resource-registry',
        leaseMs: 30_000,
      });
      if (lock) {
        try {
          return await callback();
        } finally {
          await lock.release();
        }
      }
      await delay(10);
    } while (Date.now() < deadline);
    throw new Error('Resource registry transaction timed out');
  }

  async read<T>(name: string, schema: z.ZodType<T>): Promise<T | null> {
    let content: string;
    try {
      content = await readFile(join(this.root, name), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return schema.parse(JSON.parse(content));
  }

  async list<T>(directory: string, schema: z.ZodType<T>): Promise<T[]> {
    const entries = await readdir(join(this.root, directory), { withFileTypes: true });
    const records: T[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile()) throw new Error('Resource record is not a regular file');
      const record = await this.read(`${directory}/${entry.name}`, schema);
      if (!record) throw new Error('Resource record disappeared during transaction');
      records.push(record);
    }
    return records;
  }

  async write(name: string, record: unknown): Promise<void> {
    const destination = join(this.root, name);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
