// The Wave-0 suite, UNCHANGED, against the fake. The only glue is the translation of the suite's BrainScript into
// a FakeScript: one `model-request` per scripted turn, its text, then its tool calls.
import type { AgentRuntime } from '@cohorte/runtime-contract';
import { type BrainScript, type RuntimeFactory, runtimeConformance } from '@cohorte/runtime-contract/conformance';
import { sealedText } from '@cohorte/testkit';
import { createFakeRuntimeProvider, type FakeRuntimeProvider } from '../src/fake/index.ts';
import type { FakeScript, FakeStep } from '../src/script/index.ts';

// The endpoint the suite's requests are pinned to (Lab.request).
const CONFORMANCE_BASE_URL = 'https://conformance.invalid/v1';

function fakeScriptOf(brain: BrainScript): FakeScript {
  const steps = brain.turns.flatMap((turn): FakeStep[] => [
    { do: 'model-request' },
    ...(turn.text === undefined ? [] : [{ do: 'say', text: turn.text } as const]),
    ...(turn.toolCalls ?? []).map(({ tool, input }) => ({ do: 'tool', tool, input }) as const),
  ]);
  return { version: 1, agents: [{ match: {}, steps }] };
}

const providers: FakeRuntimeProvider[] = [];

const factory: RuntimeFactory = async ({ bindings, script }): Promise<AgentRuntime> => {
  const provider = createFakeRuntimeProvider({ script: fakeScriptOf(script), baseUrl: CONFORMANCE_BASE_URL });
  providers.push(provider);
  return provider.create(bindings, await provider.pin());
};

runtimeConformance(factory, {
  // Run ids are unique per Lab, so at most one provider knows the agent.
  modelProbe: (agent) => providers.flatMap((provider) => provider.modelInputs(agent)),
  seal: sealedText,
  boundMs: 5_000,
  quietMs: 50,
});
