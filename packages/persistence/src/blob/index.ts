// `@cohorte/persistence/blob` — file-backed content-addressed storage.

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CohorteError, errorOf, type Sha256, sha256Hex } from '@cohorte/base';
import type { BlobStore } from '../contract.ts';

export interface BlobStoreOptions {
  /** `<state dir>/cas`: sharded by the first two hex digits, written atomically (temp + rename), mode 0600 */
  dir: string;
}

const ADDRESS = /^[a-f0-9]{64}$/;

function addressPath(root: string, sha256: Sha256): string {
  if (!ADDRESS.test(sha256)) throw new TypeError(`invalid blob address: ${sha256}`);
  return join(root, sha256.slice(0, 2), sha256);
}

export function createBlobStore(options: BlobStoreOptions): BlobStore {
  const root = options.dir;
  return {
    async put(bytes): Promise<{ sha256: Sha256; bytes: number }> {
      const sha256 = sha256Hex(bytes);
      const destination = addressPath(root, sha256);
      await mkdir(join(root, sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
      try {
        await stat(destination);
      } catch {
        const temporary = join(
          root,
          sha256.slice(0, 2),
          `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        );
        await writeFile(temporary, bytes, { mode: 0o600 });
        try {
          await rename(temporary, destination);
        } catch (error) {
          await writeFile(destination, bytes, { mode: 0o600 }).catch(() => {
            throw error;
          });
        }
      }
      return { sha256, bytes: bytes.byteLength };
    },
    async read(sha256): Promise<Uint8Array> {
      const bytes = await readFile(addressPath(root, sha256));
      if (sha256Hex(bytes) !== sha256) {
        throw new CohorteError(errorOf('security/pin-tampered', `blob ${sha256} no longer hashes to its address`));
      }
      return Uint8Array.from(bytes);
    },
    async has(sha256): Promise<boolean> {
      try {
        await stat(addressPath(root, sha256));
        return true;
      } catch {
        return false;
      }
    },
  };
}
