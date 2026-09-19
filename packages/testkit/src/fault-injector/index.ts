/** What `FaultInjector.hit` throws when nothing else was asked for. */
export class InjectedFault extends Error {
  readonly point: string;
  readonly occurrence: number;

  constructor(point: string, occurrence: number) {
    super(`injected fault at ${point} (hit ${occurrence})`);
    this.name = 'InjectedFault';
    this.point = point;
    this.occurrence = occurrence;
  }
}

export interface ArmOptions {
  /** Fire at this hit, counted from the moment the point is armed. Default 1. */
  nth?: number;
  /** What to throw instead of an `InjectedFault` (the error the code under test would really see). */
  error?: (point: string, occurrence: number) => unknown;
}

interface Arming {
  readonly nth: number;
  readonly error: ((point: string, occurrence: number) => unknown) | undefined;
  seen: number;
}

/**
 * In-process crash and failure points for tests. Code under test (or a fake port wrapped around it) calls
 * `hit('<point>')` where a fault may strike; a test arms a point to fail at its nth occurrence ONLY: the hits
 * before it and after it pass, which is what lets a test crash "at the third commit" and then watch a recovery
 * go through the same point unharmed. One injector per test: it holds no global state.
 */
export class FaultInjector {
  readonly #armings = new Map<string, Arming>();
  readonly #hits = new Map<string, number>();
  readonly #fired: Array<{ point: string; occurrence: number }> = [];

  arm(point: string, options: ArmOptions = {}): this {
    if (typeof point !== 'string' || point === '') throw new TypeError('FaultInjector.arm: a point needs a name');
    const nth = options.nth ?? 1;
    if (!Number.isSafeInteger(nth) || nth < 1)
      throw new RangeError(`FaultInjector.arm: nth must be a positive integer, got ${nth}`);
    this.#armings.set(point, { nth, error: options.error, seen: 0 });
    return this;
  }

  disarm(point: string): this {
    this.#armings.delete(point);
    return this;
  }

  /** Forgets every arming, every count and the firing log. */
  reset(): this {
    this.#armings.clear();
    this.#hits.clear();
    this.#fired.length = 0;
    return this;
  }

  /** Called by the code under test. Throws when this is the armed occurrence of `point`, and only then. */
  hit(point: string): void {
    this.#hits.set(point, this.hits(point) + 1);
    const arming = this.#armings.get(point);
    if (!arming) return;
    arming.seen += 1;
    if (arming.seen !== arming.nth) return;
    this.#armings.delete(point);
    this.#fired.push({ point, occurrence: arming.nth });
    throw arming.error ? arming.error(point, arming.nth) : new InjectedFault(point, arming.nth);
  }

  /** Every hit of `point` since the last reset, armed or not. */
  hits(point: string): number {
    return this.#hits.get(point) ?? 0;
  }

  /** The points still waiting to fire. */
  armed(): string[] {
    return [...this.#armings.keys()];
  }

  /** What fired, in order. */
  fired(): ReadonlyArray<{ point: string; occurrence: number }> {
    return this.#fired.map((entry) => ({ ...entry }));
  }
}
