// `@cohorte/testkit/store-factory` — the stores and ports a test asks for (PLAN PC-4, U0.06). Memory by default; a
// temp-file SQLite store when COHORTE_TEST_STORE=sqlite, which is how gate G1 re-runs the core suites on real SQLite.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, IdSource, JsonValue, Sealed } from '@cohorte/base';
import type {
  BlobStoreConformanceHooks,
  RunFilesConformanceHooks,
  StateStoreConformanceHooks,
} from '@cohorte/persistence/conformance';
import type { StateStore } from '@cohorte/persistence/contract';
import {
  createMemoryBlobStore,
  createMemoryRunFiles,
  createMemorySpool,
  createMemoryStateStore,
  MemoryBlobStore,
  MemoryRunFiles,
  type MemoryRunFilesOptions,
  type MemorySpool,
  type MemorySpoolOptions,
  MemoryStateStore,
} from '@cohorte/persistence/memory';
import { fakeRedactor } from '../fake-redactor/index.ts';

export const TEST_STORE_ENV = 'COHORTE_TEST_STORE';
export type TestStoreKind = 'memory' | 'sqlite';

export interface MakeStoreOptions {
  /** overrides COHORTE_TEST_STORE */
  kind?: TestStoreKind;
  clock?: Clock;
  ids?: IdSource;
}

export function testStoreKind(env: NodeJS.ProcessEnv = process.env): TestStoreKind {
  const asked = env[TEST_STORE_ENV] ?? 'memory';
  if (asked !== 'memory' && asked !== 'sqlite') {
    throw new RangeError(`${TEST_STORE_ENV}=${asked}: expected "memory" or "sqlite"`);
  }
  return asked;
}

/** A migrated, OPEN, empty store. The caller closes it; closing a SQLite one also removes its temp directory. */
export async function makeStore(options: MakeStoreOptions = {}): Promise<StateStore> {
  const ports = {
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.ids ? { ids: options.ids } : {}),
  };
  if ((options.kind ?? testStoreKind()) === 'memory') {
    const store = createMemoryStateStore(ports);
    await store.open();
    return store;
  }
  // LAZY on purpose: during Wave 1 the SQLite area is half-written, and a static import would evaluate it in every
  // sibling's test run. Nothing reaches it unless the environment asks for it.
  const { openSqliteStore } = await import('@cohorte/persistence/sqlite');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cohorte-store-')));
  const store = openSqliteStore({ path: join(dir, 'cohorte.db'), ...ports });
  const close = store.close.bind(store);
  store.close = async (): Promise<void> => {
    await close();
    await rm(dir, { recursive: true, force: true });
  };
  await store.migrate('apply');
  await store.open();
  return store;
}

export function makeBlobStore(): MemoryBlobStore {
  return createMemoryBlobStore();
}

export function makeRunFiles(options: MemoryRunFilesOptions = {}): MemoryRunFiles {
  return createMemoryRunFiles(options);
}

export function makeSpool(options: MemorySpoolOptions = {}): MemorySpool {
  return createMemorySpool(options);
}

/** Seals a value the test built and KNOWS to be harmless, for the APIs that only accept sealed values (I7). */
export function sealForTest<T>(value: T): Sealed<T> {
  return fakeRedactor().sealJson(value as JsonValue).value as Sealed<T>;
}

const memory = <T>(value: unknown, kind: abstract new (...args: never[]) => T, what: string): T => {
  if (value instanceof kind) return value;
  throw new TypeError(`${what}: these hooks only know the memory implementation`);
};

/** The hooks `stateStoreConformance` needs, for a MemoryStateStore. A SQLite store brings its own (U1.01). */
export function memoryStoreConformanceHooks(label = 'memory'): StateStoreConformanceHooks {
  const of = (store: StateStore): MemoryStateStore => memory(store, MemoryStateStore, 'memoryStoreConformanceHooks');
  return {
    label,
    seal: sealForTest,
    damage: async (store, id, damage) => of(store).damageJournal(id, damage),
    rewriteEvent: async (store, id, sequence) => of(store).rawRewriteEvent(id, sequence),
    purgeEvents: async (store, id) => of(store).rawPurgeEvents(id),
    snapshotCount: async (store, id) => of(store).snapshotCount(id),
  };
}

export function memoryBlobStoreConformanceHooks(label = 'memory'): BlobStoreConformanceHooks {
  return {
    label,
    tamper: async (store, sha256) => memory(store, MemoryBlobStore, 'memoryBlobStoreConformanceHooks').tamper(sha256),
  };
}

export function memoryRunFilesConformanceHooks(label = 'memory'): RunFilesConformanceHooks {
  return {
    label,
    readBack: async (files, record) =>
      memory(files, MemoryRunFiles, 'memoryRunFilesConformanceHooks').read(record.runId, record.path),
  };
}
