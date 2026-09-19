// `@cohorte/persistence/files` — run-scoped artifact files.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ArtifactId, type Clock, type RunId, sha256Hex, systemClock } from '@cohorte/base';
import type { ArtifactRecord, RunFiles } from '../contract.ts';

export interface RunFilesOptions {
  /** `<state dir>/runs` */
  dir: string;
  clock?: Clock;
}

const PLAIN_SEGMENT = /^(?!\.{1,2}$)[^/\\]+$/;
const KIND_BY_EXTENSION: Readonly<Record<string, string>> = { log: 'log', diff: 'diff', patch: 'patch' };

function plain(segments: readonly string[], what: string): readonly string[] {
  for (const segment of segments) {
    if (!PLAIN_SEGMENT.test(segment) || segment.includes('\x00')) {
      throw new RangeError(`${what}: ${JSON.stringify(segment)} is not a plain path segment`);
    }
  }
  return segments;
}

export function createRunFiles(options: RunFilesOptions): RunFiles {
  const root = options.dir;
  const clock = options.clock ?? systemClock;
  const dir = (runId: RunId, ...sub: string[]): string => join(root, ...plain([runId, ...sub], 'dir'));
  return {
    dir,
    agentDir(runId, agentId, incarnation): string {
      if (!Number.isSafeInteger(incarnation) || incarnation < 1) {
        throw new RangeError(`agentDir: incarnation ${incarnation} is not a positive integer`);
      }
      return dir(runId, 'agents', agentId, String(incarnation));
    },
    async writeArtifact(runId, rel, bytes): Promise<ArtifactRecord> {
      const segments = plain(rel.split('/'), 'writeArtifact');
      const destination = dir(runId, ...segments);
      await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { mode: 0o600 });
      const sha256 = sha256Hex(bytes);
      const extension = rel.includes('.') ? rel.slice(rel.lastIndexOf('.') + 1) : '';
      return {
        artifactId: `art_${sha256.slice(0, 32)}` as ArtifactId,
        runId,
        kind: KIND_BY_EXTENSION[extension] ?? 'file',
        path: rel,
        sha256,
        bytes: bytes.byteLength,
        createdAt: clock.now(),
      };
    },
  };
}
