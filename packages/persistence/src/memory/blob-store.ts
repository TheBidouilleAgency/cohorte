import { CohorteError, errorOf, type Sha256, sha256Hex } from '@cohorte/base';
import type { BlobStore } from '../contract.ts';

/** Content-addressed, verify-on-read, like the file-backed store of Wave 3 — in a Map. */
export class MemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<Sha256, Uint8Array>();

  async put(bytes: Uint8Array): Promise<{ sha256: Sha256; bytes: number }> {
    const sha256 = sha256Hex(bytes);
    if (!this.#blobs.has(sha256)) this.#blobs.set(sha256, Uint8Array.from(bytes));
    return { sha256, bytes: bytes.byteLength };
  }

  async read(sha256: Sha256): Promise<Uint8Array> {
    const stored = this.#blobs.get(sha256);
    if (!stored) throw new Error(`blob ${sha256} is not in the store`);
    if (sha256Hex(stored) !== sha256) {
      throw new CohorteError(errorOf('security/pin-tampered', `blob ${sha256} no longer hashes to its address`));
    }
    return Uint8Array.from(stored);
  }

  async has(sha256: Sha256): Promise<boolean> {
    return this.#blobs.has(sha256);
  }

  /** Behind the contract, for the conformance hook: flips the first stored byte and keeps the address. */
  tamper(sha256: Sha256): void {
    const stored = this.#blobs.get(sha256);
    if (!stored) throw new Error(`blob ${sha256} is not in the store`);
    const flipped = stored.byteLength > 0 ? Uint8Array.from(stored) : Uint8Array.of(0);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    this.#blobs.set(sha256, flipped);
  }
}

export function createMemoryBlobStore(): MemoryBlobStore {
  return new MemoryBlobStore();
}
