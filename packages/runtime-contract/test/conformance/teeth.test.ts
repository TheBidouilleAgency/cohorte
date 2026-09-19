import { sealedText } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import { type AgentKey, checkConformance, type RuntimeFactory } from '../../src/conformance/index.ts';
import { createEchoRuntime, type EchoMutations, type EchoRuntime } from './echo-runtime.ts';

const mutants: readonly (readonly [defect: string, mutations: EchoMutations, rule: number, says: RegExp])[] = [
  ['delivers a result without handleToolCall', { skipHandlerForOrdinal: 3 }, 1, /without a settled handleToolCall/],
  ['emits a non-monotonic seq', { repeatSeqOnce: true }, 2, /seq must strictly increase/],
  ['accepts a duplicate incarnation', { acceptDuplicateIncarnation: true }, 3, /expected a rejection/],
  ['ignores a bad prompt hash', { ignoreAssetHashes: true }, 6, /expected a rejection/],
  ['leaves a timer after close()', { leakTimerOnClose: true }, 9, /Timeout/],
  ['delivers the note before the task', { note: 'before-task' }, 12, /does not start with the byte-identical task/],
  ['drops the note', { note: 'dropped' }, 12, /continuation note must follow the task/],
  [
    'appends the note without the fixed separator',
    { note: 'appended-bare' },
    12,
    /continuation note must follow the task/,
  ],
];

describe('the conformance suite has teeth', () => {
  test.for(mutants)('an echo runtime that %s fails rule %3$i and only that one', async ([, mutations, rule, says]) => {
    const runtimes: EchoRuntime[] = [];
    const factory: RuntimeFactory = async ({ bindings, script }) => {
      const runtime = createEchoRuntime(bindings, script, mutations);
      runtimes.push(runtime);
      return runtime;
    };
    const modelProbe = (agent: AgentKey) => runtimes.flatMap((runtime) => runtime.modelInputs(agent));
    try {
      const outcomes = await checkConformance(factory, { modelProbe, seal: sealedText, boundMs: 1_000, quietMs: 30 });
      const failed = outcomes.filter((outcome) => outcome.status === 'failed');
      expect(failed.map((outcome) => outcome.rule)).toEqual([rule]);
      expect(failed[0]?.error.message).toMatch(says);
    } finally {
      for (const runtime of runtimes) runtime.stopLeaks();
    }
  });
});
