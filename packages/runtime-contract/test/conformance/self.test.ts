import { sealedText } from '@cohorte/testkit';
import { describe, expect, test } from 'vitest';
import {
  type AgentKey,
  CONFORMANCE_RULES,
  checkConformance,
  type RuntimeFactory,
  runtimeConformance,
} from '../../src/conformance/index.ts';
import { createEchoRuntime, type EchoRuntime } from './echo-runtime.ts';

// One probe for every runtime the factory hands out: the suite asks by agent, and each rule uses its own run id.
const runtimes: EchoRuntime[] = [];
const factory: RuntimeFactory = async ({ bindings, script }) => {
  const runtime = createEchoRuntime(bindings, script);
  runtimes.push(runtime);
  return runtime;
};
const modelProbe = (agent: AgentKey) => runtimes.flatMap((runtime) => runtime.modelInputs(agent));
const options = { modelProbe, seal: sealedText, boundMs: 2_000, quietMs: 50 };

// The suite exactly as a runtime package runs it.
runtimeConformance(factory, options);

describe('the conformance suite', () => {
  test('numbers the twelve rules of DESIGN 2.2', () => {
    expect(CONFORMANCE_RULES.map((rule) => rule.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test('every rule applies to the echo runtime and passes', async () => {
    const outcomes = await checkConformance(factory, options);
    expect(outcomes.map(({ rule, status }) => ({ rule, status }))).toEqual(
      CONFORMANCE_RULES.map((rule) => ({ rule: rule.id, status: 'passed' })),
    );
  });
});
