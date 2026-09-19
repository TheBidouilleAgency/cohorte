import { type AgentId, type ArtifactId, type Clock, type RunId, sha256Hex, systemClock } from '@cohorte/base';
import type { ArtifactRecord, RunFiles } from '../contract.ts';

export interface MemoryRunFilesOptions {
  /** the virtual `state/runs` directory; POSIX, no trailing slash */
  root?: string;
  clock?: Clock;
}

// Path separators, NUL and the two dot names: a segment is one plain directory entry or it is refused.
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

/** RunFiles without a disk: paths are virtual, bytes live in a Map keyed by their full path. */
export class MemoryRunFiles implements RunFiles {
  readonly #root: string;
  readonly #clock: Clock;
  readonly #files = new Map<string, Uint8Array>();

  constructor(options: MemoryRunFilesOptions = {}) {
    this.#root = options.root ?? '/memory/state/runs';
    this.#clock = options.clock ?? systemClock;
  }

  dir(runId: RunId, ...sub: string[]): string {
    return [this.#root, ...plain([runId, ...sub], 'dir')].join('/');
  }

  agentDir(runId: RunId, agentId: AgentId, incarnation: number): string {
    if (!Number.isSafeInteger(incarnation) || incarnation < 1) {
      throw new RangeError(`agentDir: incarnation ${incarnation} is not a positive integer`);
    }
    return this.dir(runId, 'agents', agentId, String(incarnation));
  }

  async writeArtifact(runId: RunId, rel: string, bytes: Uint8Array): Promise<ArtifactRecord> {
    const segments = plain(rel.split('/'), 'writeArtifact');
    const sha256 = sha256Hex(bytes);
    this.#files.set(this.dir(runId, ...segments), Uint8Array.from(bytes));
    const extension = rel.includes('.') ? rel.slice(rel.lastIndexOf('.') + 1) : '';
    return {
      artifactId: `art_${sha256.slice(0, 32)}` as ArtifactId,
      runId,
      // A default the caller overrides before `putArtifact`: this port is not told what the bytes are.
      kind: KIND_BY_EXTENSION[extension] ?? 'file',
      path: rel,
      sha256,
      bytes: bytes.byteLength,
      createdAt: this.#clock.now(),
    };
  }

  /** Not part of the port: how a test (and the conformance hook) reads an artifact back. */
  read(runId: RunId, rel: string): Uint8Array {
    const stored = this.#files.get(this.dir(runId, ...plain(rel.split('/'), 'read')));
    if (!stored) throw new Error(`no artifact at ${rel} in run ${runId}`);
    return Uint8Array.from(stored);
  }
}

export function createMemoryRunFiles(options: MemoryRunFilesOptions = {}): MemoryRunFiles {
  return new MemoryRunFiles(options);
}
