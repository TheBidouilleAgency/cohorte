import { blobStoreConformance, runFilesConformance, spoolConformance } from '@cohorte/persistence/conformance';
import {
  makeBlobStore,
  makeRunFiles,
  makeSpool,
  memoryBlobStoreConformanceHooks,
  memoryRunFilesConformanceHooks,
} from '@cohorte/testkit/store-factory';

blobStoreConformance(async () => makeBlobStore(), memoryBlobStoreConformanceHooks());
runFilesConformance(async () => makeRunFiles(), memoryRunFilesConformanceHooks());
spoolConformance(async () => makeSpool(), { label: 'memory' });
