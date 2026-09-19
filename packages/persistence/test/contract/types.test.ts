import {
  createBlobStore,
  createEphemeralSpool,
  createMigrator,
  createRunFiles,
  openSqliteStore,
} from '@cohorte/persistence';
import type {
  EventDraft,
  RunRecord,
  SealedEventDraft,
  SqlDriver,
  StateStore,
  StoreTx,
} from '@cohorte/persistence/contract';
import { locksConflict, NO_RUN_ID, zonesOverlap } from '@cohorte/persistence/contract';
import { describe, expect, expectTypeOf, test } from 'vitest';

const constructorDir = `/tmp/cohorte-contract-${process.pid}`;

describe('type-level contract (kept live by tsconfig.tests.json)', () => {
  test('I7: appendEvents accepts sealed drafts only', () => {
    expectTypeOf<StoreTx['appendEvents']>().parameter(0).toEqualTypeOf<readonly SealedEventDraft[]>();
    expectTypeOf<EventDraft>().not.toExtend<SealedEventDraft>();
    expectTypeOf<SealedEventDraft>().toExtend<EventDraft>();
    expectTypeOf<readonly EventDraft[]>().not.toExtend<Parameters<StoreTx['appendEvents']>[0]>();
  });

  test('a draft carries nothing the store assigns', () => {
    expectTypeOf<EventDraft>().not.toHaveProperty('sequence');
    expectTypeOf<EventDraft>().not.toHaveProperty('sub');
    expectTypeOf<EventDraft>().not.toHaveProperty('durability');
    expectTypeOf<EventDraft>().toHaveProperty('eventId');
  });

  test('the transaction body is synchronous and the boundary asynchronous', () => {
    expectTypeOf<ReturnType<StateStore['getRun']>>().toEqualTypeOf<Promise<RunRecord | undefined>>();
    expectTypeOf<ReturnType<StoreTx['run']>>().toEqualTypeOf<RunRecord>();
    expectTypeOf<ReturnType<StoreTx['enqueueCommand']>>().toEqualTypeOf<
      'enqueued' | 'duplicate' | 'id-reuse-conflict'
    >();
  });

  test('the six host-computed run keys are optional, pinnedInstallDir is not', () => {
    expectTypeOf<RunRecord>().toHaveProperty('pinnedInstallDir').toEqualTypeOf<string>();
    expectTypeOf<Pick<RunRecord, 'snapshotDigest' | 'plan' | 'zones'>>().toExtend<{
      snapshotDigest?: unknown;
      plan?: unknown;
      zones?: unknown;
    }>();
    expectTypeOf<Record<never, never>>().toExtend<
      Pick<RunRecord, 'snapshotDigest' | 'runtimePin' | 'plan' | 'baseSha' | 'integrationBranch' | 'zones'>
    >();
  });
});

describe('frozen barrel: the names later waves fill', () => {
  const driver: SqlDriver = {
    exec: () => undefined,
    prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }),
    close: () => undefined,
  };

  // The barrel keeps these constructors available across migration waves. Each implementation must now construct its
  // port rather than returning an absent export or a typed stub.
  test.for([
    ['openSqliteStore', () => openSqliteStore({ path: ':memory:' })],
    ['createMigrator', () => createMigrator({ driver, migrationsDir: '/nowhere', cohorteVersion: '3.0.0' })],
    ['createBlobStore', () => createBlobStore({ dir: constructorDir })],
    ['createRunFiles', () => createRunFiles({ dir: constructorDir })],
    ['createEphemeralSpool', () => createEphemeralSpool({ dir: constructorDir })],
  ] as const)('%s is exported and constructs its port', async ([, call]) => {
    expect(call).toBeTypeOf('function');
    const made = call();
    expect(made).toBeTypeOf('object');
    // A filled port may hold a real resource: hand it back rather than leak it into the rest of the run.
    const closable = made as { close?: () => unknown };
    if (typeof closable.close === 'function') await Promise.resolve(closable.close()).catch(() => undefined);
  });
});

describe('lock arithmetic shared by every store', () => {
  test.for([
    ['src/app', 'src/app', true],
    ['src/app', 'src/app/ui', true],
    ['src', 'src/app', true],
    ['src/app', 'src/application', false],
    ['src/app/', './src/app', true],
    ['docs', 'src', false],
    ['', 'anything', true],
  ] as const)('zonesOverlap(%j, %j) = %j', ([a, b, expected]) => {
    expect(zonesOverlap(a, b)).toBe(expected);
    expect(zonesOverlap(b, a)).toBe(expected);
  });

  test('two locks conflict on the same (scope, key) unless both are shared', () => {
    const lock = (mode: 'shared' | 'exclusive', zones?: string[]) =>
      ({ scope: 'zone', key: 'project', mode, ...(zones ? { zones } : {}) }) as const;
    expect(locksConflict(lock('shared', ['a']), lock('shared', ['a']))).toBe(false);
    expect(locksConflict(lock('exclusive', ['a']), lock('shared', ['a/b']))).toBe(true);
    expect(locksConflict(lock('exclusive', ['a']), lock('exclusive', ['b']))).toBe(false);
    expect(locksConflict(lock('exclusive'), lock('exclusive', ['b']))).toBe(true);
    expect(locksConflict({ ...lock('exclusive'), scope: 'run' }, lock('exclusive'))).toBe(false);
    expect(NO_RUN_ID).toBe('');
  });
});
