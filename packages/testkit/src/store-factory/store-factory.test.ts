import { MemoryBlobStore, MemoryRunFiles, MemorySpool, MemoryStateStore } from '@cohorte/persistence/memory';
import { describe, expect, test } from 'vitest';
import { makeBlobStore, makeRunFiles, makeSpool, makeStore, sealForTest, testStoreKind } from './index.ts';

describe('store-factory', () => {
  test('makeStore() is an open MemoryStateStore by default', async () => {
    const store = await makeStore({ kind: 'memory' });
    expect(store).toBeInstanceOf(MemoryStateStore);
    expect(await store.listRuns({ limit: 1, offset: 0 })).toEqual([]);
    await store.close();
  });

  test('COHORTE_TEST_STORE selects the store and refuses a value it does not know', () => {
    expect(testStoreKind({})).toBe('memory');
    expect(testStoreKind({ COHORTE_TEST_STORE: 'sqlite' })).toBe('sqlite');
    expect(() => testStoreKind({ COHORTE_TEST_STORE: 'postgres' })).toThrow(RangeError);
  });

  test('the other ports are the memory implementations', () => {
    expect(makeBlobStore()).toBeInstanceOf(MemoryBlobStore);
    expect(makeRunFiles()).toBeInstanceOf(MemoryRunFiles);
    expect(makeSpool()).toBeInstanceOf(MemorySpool);
  });

  test('sealForTest returns the value it was given, as JSON', () => {
    expect(sealForTest({ a: [1, 'two'] })).toEqual({ a: [1, 'two'] });
  });
});
