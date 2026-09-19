// apps/cli/src/compose/index.ts — AREA barrel (DESIGN 1.2 apps/cli composition root). Assembles the real
// `CliContext` and resolves the production Pi runtime by default, while retaining the fake runtime for tests.

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createUuidV7IdSource, systemClock } from '@cohorte/base';
import { openSqliteStore } from '@cohorte/persistence/sqlite';
import { createFakeRuntimeProvider, fakeScript } from '@cohorte/runtime-fake';
import { createPiRuntimeProvider } from '@cohorte/runtime-pi';
import { createRedactor } from '@cohorte/security/redact';
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
  const install = createInstallInspector();
  const fakeRuntime = createFakeRuntimeProvider({ script: fakeScript().build(), clock: systemClock });
  const piRuntime = createPiRuntimeProvider({ installDir: install.installDir(), redactor: createRedactor() });
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
    runtime: {
      // Pi is the production runtime and the configured V3 default. Keep the fake
      // available for explicit offline/test callers without making it the CLI default.
      resolve: (name) => (name === 'fake' ? fakeRuntime : piRuntime),
      capabilities: () => ({ provider: piRuntime.id }),
    },
    assets,
    install,
  };
}
