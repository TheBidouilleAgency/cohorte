// `@cohorte/persistence/conformance` — the suites every implementation of this package's ports must pass
// (DESIGN 2.4). Delivered COMPLETE in Wave 0: an implementation RUNS them from one of its test files, nobody fills them.
export {
  type BlobStoreConformanceHooks,
  blobStoreConformance,
  type RunFilesConformanceHooks,
  runFilesConformance,
  type SpoolConformanceHooks,
  spoolConformance,
  spoolLine,
} from './ports.ts';
export { type ChainDamage, type StateStoreConformanceHooks, stateStoreConformance } from './state-store.ts';
