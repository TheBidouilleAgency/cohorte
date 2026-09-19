import { assertIdPrefix, type Brand, type IdSource } from '@cohorte/base';

export interface SeqIdsOptions {
  /** Every counter starts at `seed + 1`. Default 0. */
  seed?: number;
}

/**
 * The deterministic IdSource: `<prefix>_<counter as 32 hex digits>`, one counter per prefix, so an id keeps its
 * value when a test starts minting an unrelated kind of id. The shape is the one `parseId` demands of the real
 * uuidv7 ids (`run_`, `evt_`, `cmd_`, `apr_`, `eff_` + 32 hex), and ids sort in minting order like the real ones.
 */
export class SeqIds implements IdSource {
  readonly #seed: number;
  readonly #counters = new Map<string, number>();

  constructor(options: SeqIdsOptions = {}) {
    const seed = options.seed ?? 0;
    if (!Number.isSafeInteger(seed) || seed < 0)
      throw new RangeError(`SeqIds: seed must be a non-negative integer, got ${seed}`);
    this.#seed = seed;
  }

  next<B extends string>(prefix: string): Brand<string, B> {
    assertIdPrefix(prefix);
    const minted = this.count(prefix) + 1;
    this.#counters.set(prefix, minted);
    return `${prefix}_${(this.#seed + minted).toString(16).padStart(32, '0')}` as Brand<string, B>;
  }

  /** How many ids were minted for this prefix. */
  count(prefix: string): number {
    return this.#counters.get(prefix) ?? 0;
  }
}
