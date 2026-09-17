import { AsyncLocalStorage } from 'node:async_hooks';
import type { CommandExecutor } from '../utils/CommandExecutor.ts';

const supervisionStorage = new AsyncLocalStorage<CommandSupervision>();

/** Completion evidence for the finite command executors used by admitted tools. */
export class CommandSupervision {
  private pending = 0;
  private uncertain = false;

  get quiescent(): boolean {
    return this.pending === 0 && !this.uncertain;
  }

  run<T>(invoke: () => Promise<T>): Promise<T> {
    return supervisionStorage.run(this, invoke);
  }

  async execute(
    executor: CommandExecutor,
    args: Parameters<CommandExecutor>,
  ): ReturnType<CommandExecutor> {
    if (this.uncertain) throw new Error('Previous managed command completion is uncertain');
    if (args[4]) throw new Error('Detached commands are unsupported with managed resources');
    this.pending++;
    try {
      const result = await executor(...args);
      const child = result.process;
      // The shared executor can settle 100ms after exit while descendants still hold stdio.
      // Exit alone is insufficient evidence; swallowed errors must remain uncertain too.
      const exited =
        child && (typeof child.exitCode === 'number' || typeof child.signalCode === 'string');
      const streamsClosed =
        child &&
        [child.stdout, child.stderr].every(
          (stream) => !stream || stream.destroyed || stream.readableEnded,
        );
      if (!exited || !streamsClosed) {
        this.uncertain = true;
        throw new Error('Managed command completion is uncertain');
      }
      return result;
    } catch (error) {
      this.uncertain = true;
      throw error;
    } finally {
      this.pending--;
    }
  }
}

export function isCommandSupervised(): boolean {
  return supervisionStorage.getStore() !== undefined;
}

export function supervisedExecutor(executor: CommandExecutor): CommandExecutor {
  return (...args) => {
    const supervision = supervisionStorage.getStore();
    return supervision ? supervision.execute(executor, args) : executor(...args);
  };
}
