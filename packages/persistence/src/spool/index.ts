// `@cohorte/persistence/spool` — bounded, file-backed NDJSON tail.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunId } from '@cohorte/base';
import { compareOrder } from '@cohorte/protocol';
import type { EphemeralSpool } from '../contract.ts';

export interface EphemeralSpoolOptions {
  /** `<state dir>/runs`: one bounded NDJSON spool file per run */
  dir: string;
  maxBytes?: number;
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

export function createEphemeralSpool(options: EphemeralSpoolOptions): EphemeralSpool {
  const root = options.dir;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('spool maxBytes must be positive');
  const pathFor = (runId: RunId): string => join(root, `${runId}.ndjson`);
  const readLines = (runId: RunId): Line[] => {
    try {
      return readFileSync(pathFor(runId), 'utf8').split('\n').filter(Boolean).map(parse).sort(compareOrder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  const trim = (runId: RunId): void => {
    const path = pathFor(runId);
    const bytes = readFileSync(path);
    if (bytes.byteLength <= maxBytes) return;
    const lines = readLines(runId);
    const kept = lines.map((line) => line.text);
    while (kept.length > 0 && Buffer.byteLength(`${kept.join('\n')}\n`) > maxBytes) kept.shift();
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
    renameSync(temporary, path);
  };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return {
    append(runId, line): void {
      parse(line);
      appendFileSync(pathFor(runId), `${line}\n`, { mode: 0o600 });
      trim(runId);
    },
    async *tail(runId, after, signal): AsyncIterable<string> {
      let cursor = after;
      while (!signal.aborted) {
        const next = readLines(runId).find((line) => compareOrder(line, cursor) > 0);
        if (next) {
          cursor = { sequence: next.sequence, sub: next.sub };
          yield next.text;
          continue;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  };
}
