// apps/cli/src/compose/index.ts — AREA barrel (DESIGN 1.2 apps/cli composition root; PLAN §3 rule 3 "frozen
// barrel, typed stub"). Assembles the real `CliContext` (open the store, wire the controller/observer/host
// spawner/renderer, resolve runtime providers) from process-level inputs. Wave-0 stub: filled by `U4.01`, which
// owns `apps/cli/src/compose/**`.

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createUuidV7IdSource, systemClock } from '@cohorte/base';
import { openSqliteStore } from '@cohorte/persistence/sqlite';
import { createFakeRuntimeProvider, fakeScript } from '@cohorte/runtime-fake';
import { createAssetSource } from '../assets/index.ts';
import type { CliContext } from '../contract/index.ts';
import { createController } from '../control/index.ts';
import { createHostSpawner } from '../host/index.ts';
import type { ComposeInputs } from '../lazy.ts';
import { createObserver } from '../observe/index.ts';
import { createInstallInspector } from '../pin/index.ts';
import { createRenderer } from '../render/index.ts';
import { createProductionHostRunner } from './engine.ts';

export async function composeCliContext(inputs: ComposeInputs): Promise<CliContext> {
  const ids = createUuidV7IdSource();
  const runtime = createFakeRuntimeProvider({ script: fakeScript().build(), clock: systemClock });
  const install = createInstallInspector();
  const assets = createAssetSource();
  const createStore = async () => {
    const stateDir = join(inputs.cwd, '.cohorte', 'state');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const migrationsDir = dirname((await assets.migration('state/0001_init.sql')).path);
    const databasePath = join(stateDir, 'cohorte.db');
    const store = openSqliteStore({ path: databasePath, migrationsDir, clock: systemClock, ids });
    return store;
  };
  const openMigrationStore = createStore;
  const openStore = async () => {
    const store = await createStore();
    if ((await store.migrate('check')).current === 0) await store.migrate('apply');
    await store.open();
    return store;
  };
  return {
    clock: systemClock,
    ids,
    stdio: inputs.stdio,
    cwd: inputs.cwd,
    env: inputs.env,
    openStore,
    openMigrationStore,
    controller: createController({
      openStore,
      clock: systemClock,
      ids,
      cwd: inputs.cwd,
      home: inputs.env.HOME ?? process.cwd(),
      pinnedInstallDir: install.installDir(),
    }),
    observer: createObserver(async () => {
      const stateDir = join(inputs.cwd, '.cohorte', 'state');
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const migrationsDir = dirname((await assets.migration('state/0001_init.sql')).path);
      const databasePath = join(stateDir, 'cohorte.db');
      const store = openSqliteStore({ path: databasePath, migrationsDir, clock: systemClock, ids });
      if ((await store.migrate('check')).current === 0) await store.migrate('apply');
      await store.open();
      return store;
    }),
    hostSpawner: createHostSpawner({ cwd: inputs.cwd, openStore, install }),
    hostRunner: {
      async run(runId) {
        const store = await openStore();
        try {
          const runner = await createProductionHostRunner({
            store,
            openStore,
            cwd: inputs.cwd,
            home: inputs.env.HOME ?? inputs.cwd,
            env: inputs.env,
            ids,
            install,
            assetsTreeSha256: assets.treeSha256(),
          });
          return await runner.run(runId);
        } finally {
          await store.close();
        }
      },
    },
    renderer: createRenderer(),
    runtime: { resolve: () => runtime, capabilities: () => ({ provider: runtime.id }) },
    assets,
    install,
  };
}
