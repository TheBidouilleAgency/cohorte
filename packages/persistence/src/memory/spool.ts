import type { RunId } from '@cohorte/base';
import { compareOrder } from '@cohorte/protocol';
import type { EphemeralSpool } from '../contract.ts';

export interface MemorySpoolOptions {
  /** per run; the oldest lines go first. The spool is ephemeral by contract: losing old lines is legal. */
  maxLines?: number;
}

interface Line {
  sequence: number;
  sub: number;
  text: string;
}

function parse(line: string): Line {
  if (line.includes('\n')) throw new TypeError('spool: one line per append');
  const value: unknown = JSON.parse(line);
  const { sequence, sub } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (
    typeof sequence !== 'number' ||
    typeof sub !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    !Number.isSafeInteger(sub)
  ) {
    throw new TypeError('spool: a line is one JSON object with an integer `sequence` and `sub`');
  }
  return { sequence, sub, text: line };
}

/** The ephemeral spool in memory: lines kept in `(sequence, sub)` order per run, tails woken on append. */
export class MemorySpool implements EphemeralSpool {
  readonly #lines = new Map<RunId, Line[]>();
  readonly #waiters = new Map<RunId, Set<() => void>>();
  readonly #maxLines: number;

  constructor(options: MemorySpoolOptions = {}) {
    this.#maxLines = options.maxLines ?? 10_000;
  }

  append(runId: RunId, line: string): void {
    const parsed = parse(line);
    const lines = this.#lines.get(runId) ?? [];
    this.#lines.set(runId, lines);
    // Appends arrive nearly sorted: walk back from the end.
    let at = lines.length;
    for (let before = lines[at - 1]; before && compareOrder(before, parsed) > 0; before = lines[at - 1]) at -= 1;
    lines.splice(at, 0, parsed);
    if (lines.length > this.#maxLines) lines.splice(0, lines.length - this.#maxLines);
    const waiters = this.#waiters.get(runId);
    this.#waiters.delete(runId);
    for (const wake of waiters ?? []) wake();
  }

  async *tail(runId: RunId, after: { sequence: number; sub: number }, signal: AbortSignal): AsyncIterable<string> {
    let cursor = { sequence: after.sequence, sub: after.sub };
    while (!signal.aborted) {
      const next = (this.#lines.get(runId) ?? []).find((line) => compareOrder(line, cursor) > 0);
      if (next) {
        cursor = { sequence: next.sequence, sub: next.sub };
        yield next.text;
        continue;
      }
      await new Promise<void>((resolve) => {
        const waiters = this.#waiters.get(runId) ?? new Set();
        this.#waiters.set(runId, waiters);
        const wake = (): void => {
          signal.removeEventListener('abort', wake);
          waiters.delete(wake);
          resolve();
        };
        waiters.add(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
  }
}

export function createMemorySpool(options: MemorySpoolOptions = {}): MemorySpool {
  return new MemorySpool(options);
}
