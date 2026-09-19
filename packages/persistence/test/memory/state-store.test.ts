import { stateStoreConformance } from '@cohorte/persistence/conformance';
import { FixedClock, SeqIds } from '@cohorte/testkit';
import { makeStore, memoryStoreConformanceHooks } from '@cohorte/testkit/store-factory';

// Twice: with the real clock and uuidv7 ids, and with the deterministic ports every core unit will inject.
stateStoreConformance(() => makeStore({ kind: 'memory' }), memoryStoreConformanceHooks('memory'));
stateStoreConformance(
  () => makeStore({ kind: 'memory', clock: new FixedClock(), ids: new SeqIds() }),
  memoryStoreConformanceHooks('memory, fixed clock + sequential ids'),
);
