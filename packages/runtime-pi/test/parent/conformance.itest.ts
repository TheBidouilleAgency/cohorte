// The Wave-0 conformance suite, run on the PARENT of PiRuntime driving the engine-free fake brain — once per
// transport codec. The engine itself is put through the same suite by U5.04.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RuntimeFactory, runtimeConformance } from '@cohorte/runtime-contract/conformance';
import { fakeRedactor, sealedText } from '@cohorte/testkit';
import { FAKE_BRAIN_ENTRY, readFakeBrainModelInputs, writeFakeBrainScript } from '@cohorte/testkit/fake-brain/scripts';
import { afterAll } from 'vitest';
import { createPiRuntimeProvider } from '../../src/parent/index.ts';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'cohorte-pi-conformance-')));
afterAll(() => rmSync(home, { recursive: true, force: true }));

for (const transport of ['ipc', 'fd'] as const) {
  const stateDirs = new Map<string, string>();
  const factory: RuntimeFactory = async ({ bindings, script }) => {
    const provider = createPiRuntimeProvider({
      entryOverride: FAKE_BRAIN_ENTRY,
      redactor: fakeRedactor(),
      transport,
      engine: { agentDir: join(home, 'pi-agent'), authPath: join(home, 'auth.json') },
    });
    const pinned = await provider.pin();
    return provider.create(
      {
        ...bindings,
        // The state dir is the child's cwd: the only channel through which a test can hand the fake brain its script.
        stateDir: (runId, agentId, incarnation) => {
          const dir = bindings.stateDir(runId, agentId, incarnation);
          // The fake "engine" talks to ONE endpoint, whatever the request pins (rule 11).
          writeFakeBrainScript(dir, { turns: script.turns, endpoint: 'https://conformance.invalid/v1' });
          stateDirs.set(`${runId}/${agentId}/${incarnation}`, dir);
          return dir;
        },
      },
      pinned,
    );
  };

  runtimeConformance(factory, {
    label: `runtime-pi parent + fake brain, ${transport}`,
    seal: sealedText,
    modelProbe: ({ runId, agentId, incarnation }) => {
      const dir = stateDirs.get(`${runId}/${agentId}/${incarnation}`);
      return dir ? readFakeBrainModelInputs(dir) : [];
    },
  });
}
