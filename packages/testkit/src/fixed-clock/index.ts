import { type Clock, type IsoInstant, toIsoInstant } from '@cohorte/base';

interface Sleeper {
  readonly deadline: number;
  readonly order: number;
  wake(): void;
}

export interface FixedClockOptions {
  /**
   * `sleep(ms)` moves the clock forward by `ms` itself and resolves. For code that backs off and retries on its own:
   * without it such a test hangs until somebody calls `advance`.
   */
  autoAdvance?: boolean;
}

const yieldToMacrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A Clock that only moves when the test says so. `now()` and `monotonicMs()` advance together; a `sleep` resolves
 * when an advance crosses its deadline, in deadline order (first come first served on a tie).
 */
export class FixedClock implements Clock {
  static readonly DEFAULT_START = '2026-01-01T00:00:00.000Z';

  #wallMs: number;
  #monotonicMs = 0;
  #sleepers: Sleeper[] = [];
  #nextOrder = 0;
  readonly #autoAdvance: boolean;

  constructor(start: string | number | Date = FixedClock.DEFAULT_START, options: FixedClockOptions = {}) {
    this.#wallMs = FixedClock.#epochMs(start);
    this.#autoAdvance = options.autoAdvance ?? false;
  }

  static #epochMs(instant: string | number | Date): number {
    const ms = new Date(instant).getTime();
    if (!Number.isFinite(ms)) throw new RangeError(`FixedClock: ${String(instant)} is not a date`);
    return ms;
  }

  now(): IsoInstant {
    return toIsoInstant(this.#wallMs);
  }

  monotonicMs(): number {
    return this.#monotonicMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!(ms > 0)) return Promise.resolve();
    if (this.#autoAdvance) {
      this.advance(ms);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.#sleepers = this.#sleepers.filter((candidate) => candidate !== sleeper);
        reject(signal?.reason);
      };
      const sleeper: Sleeper = {
        deadline: this.#monotonicMs + ms,
        order: this.#nextOrder++,
        wake: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      this.#sleepers.push(sleeper);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** How many sleeps are waiting for an advance. */
  pendingSleeps(): number {
    return this.#sleepers.length;
  }

  /** Moves both clocks forward at once and wakes every sleeper that is due. Their continuations run afterwards, as microtasks. */
  advance(ms: number): void {
    this.#move(FixedClock.#step(ms));
    this.#wakeDue();
  }

  /**
   * Moves forward like a real clock would: stops at each deadline on the way, wakes its sleepers and lets their
   * continuations run (so they observe `now()` AT their deadline and may sleep again) before going on.
   */
  async tick(ms: number): Promise<void> {
    const target = this.#monotonicMs + FixedClock.#step(ms);
    for (;;) {
      const next = this.#sleepers.reduce((min, sleeper) => Math.min(min, sleeper.deadline), Number.POSITIVE_INFINITY);
      if (next > target) break;
      this.#move(Math.max(0, next - this.#monotonicMs));
      this.#wakeDue();
      await yieldToMacrotasks();
    }
    this.#move(target - this.#monotonicMs);
    await yieldToMacrotasks();
  }

  /** A wall-clock jump (NTP step, suspend/resume): `now()` changes, the monotonic clock and the sleepers do not. */
  setWallClock(instant: string | number | Date): void {
    this.#wallMs = FixedClock.#epochMs(instant);
  }

  static #step(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`FixedClock: cannot advance by ${ms}`);
    return ms;
  }

  #move(ms: number): void {
    this.#wallMs += ms;
    this.#monotonicMs += ms;
  }

  #wakeDue(): void {
    const due = this.#sleepers
      .filter((sleeper) => sleeper.deadline <= this.#monotonicMs)
      .sort((a, b) => a.deadline - b.deadline || a.order - b.order);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.deadline > this.#monotonicMs);
    for (const sleeper of due) sleeper.wake();
  }
}
