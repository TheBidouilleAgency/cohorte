// `@cohorte/persistence/memory` — every port of this package, in memory (DESIGN 2.4). Shipped to tests only:
// `doctor --verify-state` is the one product caller, and it rebuilds projections into a MemoryStateStore.
export { createMemoryBlobStore, MemoryBlobStore } from './blob-store.ts';
export { chainHash, envelopeOf, toEventRecord, verifyEventRecords } from './chain.ts';
export { createMemoryRunFiles, MemoryRunFiles, type MemoryRunFilesOptions } from './run-files.ts';
export { createMemorySpool, MemorySpool, type MemorySpoolOptions } from './spool.ts';
export {
  createMemoryStateStore,
  MEMORY_SCHEMA_VERSION,
  MemoryStateStore,
  type MemoryStateStoreOptions,
} from './state-store.ts';
