import type { Sha256 } from '@cohorte/base';
import type { BlobStore } from '@cohorte/persistence/contract';
import type { SnapshotDeps } from '../contract/factories.ts';
import type { PinReader } from '../contract/internal.ts';

export interface PinReference {
  sha256: Sha256;
  bytes: number;
  path: string;
}

export function createPinReader(deps: SnapshotDeps): PinReader {
  const blobs: BlobStore | undefined = deps.pinStore;
  const refs = deps.pinRefs ?? {};
  return {
    async read(logicalPath) {
      const ref = refs[logicalPath];
      if (!ref || !blobs) throw new Error(`configuration/pin-not-found: ${logicalPath}`);
      return blobs.read(ref.sha256);
    },
    ref(logicalPath) {
      const ref = refs[logicalPath];
      if (!ref) throw new Error(`configuration/pin-not-found: ${logicalPath}`);
      return ref;
    },
  };
}

export { createRunSnapshotter, type SnapshotDeps } from '../contract/factories.ts';
