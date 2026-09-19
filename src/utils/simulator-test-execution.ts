import { parseResultBundlePathArgs } from './result-bundle-args.ts';
import type { TestPreflightResult } from './test-preflight.ts';

function parseTestSelectorArgs(extraArgs: string[] | undefined): {
  remainingArgs: string[];
  selectorArgs: string[];
  resultBundlePath?: string;
} {
  const parsedResultBundleArgs = parseResultBundlePathArgs(extraArgs);
  if (parsedResultBundleArgs.remainingArgs.length === 0) {
    return {
      remainingArgs: [],
      selectorArgs: [],
      ...(parsedResultBundleArgs.resultBundlePath
        ? { resultBundlePath: parsedResultBundleArgs.resultBundlePath }
        : {}),
    };
  }

  const remainingArgs: string[] = [];
  const selectorArgs: string[] = [];

  for (let index = 0; index < parsedResultBundleArgs.remainingArgs.length; index += 1) {
    const argument = parsedResultBundleArgs.remainingArgs[index]!;

    if (argument === '-only-testing' || argument === '-skip-testing') {
      const value = parsedResultBundleArgs.remainingArgs[index + 1];
      if (value) {
        selectorArgs.push(argument, value);
        index += 1;
      }
      continue;
    }

    if (argument.startsWith('-only-testing:') || argument.startsWith('-skip-testing:')) {
      selectorArgs.push(argument);
      continue;
    }

    remainingArgs.push(argument);
  }

  return {
    remainingArgs,
    selectorArgs,
    ...(parsedResultBundleArgs.resultBundlePath
      ? { resultBundlePath: parsedResultBundleArgs.resultBundlePath }
      : {}),
  };
}

/**
 * Managed tests may narrow the test set, but may not override destinations or execution policy.
 * Keep this validation next to the parser so admission and the low-level executor share one
 * allowlist. Ordinary test execution does not call this helper.
 */
export function validateManagedTestExtraArgs(extraArgs: readonly unknown[] | undefined): void {
  if (extraArgs === undefined || extraArgs.length === 0) return;
  if (!extraArgs.every((argument): argument is string => typeof argument === 'string')) {
    throw new Error(
      'Managed simulator tests only allow -only-testing and -skip-testing selectors in extraArgs',
    );
  }

  for (let index = 0; index < extraArgs.length; index += 1) {
    const argument = extraArgs[index]!;
    if (argument === '-only-testing' || argument === '-skip-testing') {
      const value = extraArgs[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(
          'Managed simulator tests require a selector value after -only-testing or -skip-testing',
        );
      }
      index += 1;
      continue;
    }

    if (argument.startsWith('-only-testing:') || argument.startsWith('-skip-testing:')) {
      const separator = argument.indexOf(':');
      if (separator === argument.length - 1) {
        throw new Error('Managed simulator tests require a non-empty test selector');
      }
      continue;
    }

    throw new Error(
      'Managed simulator tests only allow -only-testing and -skip-testing selectors in extraArgs',
    );
  }
}

export function createSimulatorTwoPhaseExecutionPlan(params: {
  extraArgs?: string[];
  preflight?: TestPreflightResult;
  resultBundlePath?: string;
  supervised?: boolean;
}): {
  buildArgs: string[];
  testArgs: string[];
  usesExactSelectors: boolean;
  resultBundlePath?: string;
} {
  const parsedArgs = parseTestSelectorArgs(params.extraArgs);
  const selectedTestArgs = parsedArgs.selectorArgs;
  const usesExactSelectors = selectedTestArgs.length > 0;
  const resultBundlePath = params.resultBundlePath ?? parsedArgs.resultBundlePath;
  const resultBundleArgs = resultBundlePath ? ['-resultBundlePath', resultBundlePath] : [];

  const supervisedTestFlags = params.supervised
    ? ['-parallel-testing-enabled', 'NO', '-maximum-concurrent-test-simulator-destinations', '1']
    : [];

  return {
    buildArgs: [...parsedArgs.remainingArgs, ...selectedTestArgs],
    testArgs: [
      ...parsedArgs.remainingArgs,
      ...selectedTestArgs,
      ...supervisedTestFlags,
      ...resultBundleArgs,
    ],
    usesExactSelectors,
    ...(resultBundlePath ? { resultBundlePath } : {}),
  };
}
