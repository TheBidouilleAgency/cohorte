// Conformance of the three OTHER ports of this package (DESIGN 2.4): small on purpose, green on the memory
// implementations in Wave 0 and re-run unchanged on the file-backed ones (U3.02).
import { CohorteError, type RunId, type Sha256, sha256Hex } from '@cohorte/base';
import { describe, expect, test } from 'vitest';
import type { ArtifactRecord, BlobStore, EphemeralSpool, RunFiles } from '../contract.ts';
import { agentId, runId } from './fixtures.ts';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

export interface BlobStoreConformanceHooks {
  label?: string;
  /** Flips stored bytes BEHIND the contract, keeping the address. */
  tamper(store: BlobStore, sha256: Sha256): Promise<void>;
}

export function blobStoreConformance(factory: () => Promise<BlobStore>, hooks: BlobStoreConformanceHooks): void {
  describe(`BlobStore conformance${hooks.label ? ` (${hooks.label})` : ''}`, () => {
    test('put is content-addressed and idempotent; read gives the bytes back', async () => {
      const store = await factory();
      const data = bytesOf('hello blob');
      const first = await store.put(data);
      expect(first).toEqual({ sha256: sha256Hex(data), bytes: data.byteLength });
      expect(await store.put(data)).toEqual(first);
      expect(await store.has(first.sha256)).toBe(true);
      expect([...(await store.read(first.sha256))]).toEqual([...data]);
    });

    test('the store keeps its own copy of what it was given and of what it returns', async () => {
      const store = await factory();
      const data = bytesOf('copy me');
      const { sha256 } = await store.put(data);
      data.fill(0);
      const read = await store.read(sha256);
      read.fill(0);
      expect(new TextDecoder().decode(await store.read(sha256))).toBe('copy me');
    });

    test('an unknown address: has() is false and read() rejects', async () => {
      const store = await factory();
      const missing = sha256Hex('never stored');
      expect(await store.has(missing)).toBe(false);
      await expect(store.read(missing)).rejects.toThrow();
    });

    test('a tampered blob fails verify-on-read with security/pin-tampered', async () => {
      const store = await factory();
      const { sha256 } = await store.put(bytesOf('pinned asset'));
      await hooks.tamper(store, sha256);
      const thrown: unknown = await store.read(sha256).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(CohorteError);
      expect((thrown as CohorteError).info.code).toBe('security/pin-tampered');
    });
  });
}

export interface RunFilesConformanceHooks {
  label?: string;
  /** Reads an artifact back from where the implementation put it. */
  readBack(files: RunFiles, record: ArtifactRecord): Promise<Uint8Array>;
}

export function runFilesConformance(factory: () => Promise<RunFiles>, hooks: RunFilesConformanceHooks): void {
  describe(`RunFiles conformance${hooks.label ? ` (${hooks.label})` : ''}`, () => {
    const id = runId('files');

    test('every run has its own directory, every incarnation of an agent its own below it', async () => {
      const files = await factory();
      const root = files.dir(id);
      expect(root).toContain(id);
      expect(files.dir(runId('other'))).not.toBe(root);
      expect(files.dir(id, 'artifacts', 'logs')).toBe(`${root}/artifacts/logs`);
      const first = files.agentDir(id, agentId('impl'), 1);
      const second = files.agentDir(id, agentId('impl'), 2);
      expect(first.startsWith(`${root}/`)).toBe(true);
      expect(first).toContain(agentId('impl'));
      expect(second).not.toBe(first);
      expect(files.agentDir(id, agentId('impl'), 1)).toBe(first);
    });

    test('writeArtifact records the digest, the size and the relative path, and the bytes can be read back', async () => {
      const files = await factory();
      const data = bytesOf('check output\n');
      const record = await files.writeArtifact(id, 'artifacts/check.log', data);
      expect(record).toMatchObject({
        runId: id,
        path: 'artifacts/check.log',
        sha256: sha256Hex(data),
        bytes: data.byteLength,
      });
      expect(record.artifactId).toBe(`art_${sha256Hex(data).slice(0, 32)}`);
      expect([...(await hooks.readBack(files, record))]).toEqual([...data]);
    });

    test.for(['../escape.log', '/etc/passwd', 'a/../../b', '', 'a\\b', 'a/./b'])(
      'a relative path that is not a plain one is refused: %j',
      async (rel) => {
        const files = await factory();
        await expect(files.writeArtifact(id, rel, bytesOf('x'))).rejects.toThrow();
      },
    );

    test('a segment that is not a plain name cannot leave the run directory', async () => {
      const files = await factory();
      expect(() => files.dir(id, '..', 'x')).toThrow();
      expect(() => files.dir('../run' as RunId)).toThrow();
    });
  });
}

export interface SpoolConformanceHooks {
  label?: string;
}

/** One spool line: an NDJSON object carrying at least the stream position. */
export const spoolLine = (sequence: number, sub: number, text = ''): string =>
  JSON.stringify({ sequence, sub, type: 'agent.output.delta', payload: { text } });

export function spoolConformance(factory: () => Promise<EphemeralSpool>, hooks: SpoolConformanceHooks = {}): void {
  describe(`EphemeralSpool conformance${hooks.label ? ` (${hooks.label})` : ''}`, () => {
    const id = runId('spool');
    const take = async (spool: EphemeralSpool, after: { sequence: number; sub: number }, count: number) => {
      const controller = new AbortController();
      const lines: string[] = [];
      if (count === 0) controller.abort();
      for await (const line of spool.tail(id, after, controller.signal)) {
        lines.push(line);
        if (lines.length >= count) controller.abort();
      }
      return lines.map((line) => {
        const { sequence, sub } = JSON.parse(line) as { sequence: number; sub: number };
        return [sequence, sub];
      });
    };

    test('tail is ordered by (sequence, sub) and starts strictly after the position', async () => {
      const spool = await factory();
      spool.append(id, spoolLine(1, 1));
      spool.append(id, spoolLine(2, 1));
      spool.append(id, spoolLine(1, 2));
      spool.append(id, spoolLine(10, 1));
      spool.append(id, spoolLine(2, 2));
      expect(await take(spool, { sequence: 0, sub: 0 }, 5)).toEqual([
        [1, 1],
        [1, 2],
        [2, 1],
        [2, 2],
        [10, 1],
      ]);
      expect(await take(spool, { sequence: 1, sub: 2 }, 3)).toEqual([
        [2, 1],
        [2, 2],
        [10, 1],
      ]);
    });

    test('tail follows lines appended after it started, and ends when aborted', async () => {
      const spool = await factory();
      spool.append(id, spoolLine(1, 1));
      const following = take(spool, { sequence: 0, sub: 0 }, 3);
      await new Promise((resolve) => setImmediate(resolve));
      spool.append(id, spoolLine(1, 2));
      spool.append(id, spoolLine(2, 1));
      expect(await following).toEqual([
        [1, 1],
        [1, 2],
        [2, 1],
      ]);
      expect(await take(spool, { sequence: 0, sub: 0 }, 0)).toEqual([]);
    });

    test('runs do not see each other, and a line that is not one JSON object with a position is refused', async () => {
      const spool = await factory();
      spool.append(runId('someone-else'), spoolLine(1, 1));
      spool.append(id, spoolLine(3, 1));
      expect(await take(spool, { sequence: 0, sub: 0 }, 1)).toEqual([[3, 1]]);
      expect(() => spool.append(id, 'not json')).toThrow();
      expect(() => spool.append(id, JSON.stringify({ sequence: 1 }))).toThrow();
      expect(() => spool.append(id, `${spoolLine(4, 1)}\n${spoolLine(4, 2)}`)).toThrow();
    });
  });
}
