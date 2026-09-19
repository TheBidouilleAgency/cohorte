// U1.01: the two multi-PROCESS properties the plan calls for — real `node` child processes, real file contention,
// not simulated inside one JS heap (DESIGN 2.4 "asynchronous boundary, synchronous transaction body"; F-6 of the
// toolchain understanding measured the same property at the raw `node:sqlite` level).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { HOST_COLUMNS, idleRun, runId, runLock, startCommand } from '../../src/conformance/fixtures.ts';
import { openTempSqliteStore } from './support/factory.ts';

const CONCURRENT_WRITER = fileURLToPath(new URL('./support/concurrent-writer.ts', import.meta.url));
const CONCURRENT_START = fileURLToPath(new URL('./support/concurrent-start.ts', import.meta.url));

describe('3 processes x 400 transactions', () => {
  test('no lost update, gapless sequences', async () => {
    const { store, dbPath } = await openTempSqliteStore();
    const id = runId('fork-write');
    await store.transact('project', null, (tx) => tx.putRun(idleRun(id)));
    const granted = await store.acquireLock(runLock(id));
    if (!granted.ok) throw new Error('lock held');
    await store.transact({ runId: id }, granted.lease, (tx) => tx.patchRun(id, { state: 'BUILD', ...HOST_COLUMNS }));

    const perProcess = 400;
    const labels = ['w1', 'w2', 'w3'];
    const runs = labels.map(
      (label) =>
        new Promise<{ label: string; code: number | null }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [CONCURRENT_WRITER, dbPath, id, JSON.stringify(granted.lease), String(perProcess), label],
            { stdio: ['ignore', 'inherit', 'inherit'] },
          );
          child.once('error', reject);
          child.once('exit', (code) => resolve({ label, code }));
        }),
    );
    const results = await Promise.all(runs);
    for (const result of results) expect(result.code, `writer ${result.label}`).toBe(0);

    const after = await store.getRun(id);
    expect(after?.lastSequence).toBe(perProcess * labels.length);
    const events = await store.readEvents(id, { afterSequence: 0, limit: perProcess * labels.length + 10 });
    expect(events).toHaveLength(perProcess * labels.length);
    const sequences = events.map((event) => event.sequence);
    expect(new Set(sequences).size).toBe(sequences.length); // no lost update: every sequence distinct
    expect(Math.min(...sequences)).toBe(1);
    expect(Math.max(...sequences)).toBe(perProcess * labels.length); // gapless: max == count
    expect(await store.verifyChain(id)).toMatchObject({ ok: true, events: perProcess * labels.length });

    await store.close();
  }, 30_000);
});

describe('two processes racing `start` with the same commandId', () => {
  test('exactly one run row, one pending command, the loser gets duplicate', async () => {
    const dir = await openTempSqliteStore();
    const id = runId('fork-start');
    const command = startCommand('fork-start-cmd', id);
    const run = idleRun(id);

    const spawnOne = (): Promise<{ code: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
          CONCURRENT_START,
          dir.dbPath,
          JSON.stringify(run),
          JSON.stringify(command),
        ]);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, stdout, stderr }));
      });

    // Both `spawn` calls fire before either child can finish: real concurrent OS processes, not a sequential await.
    const [first, second] = await Promise.all([spawnOne(), spawnOne()]);
    for (const result of [first, second]) {
      expect(result.code, result.stderr).toBe(0);
    }
    const statuses = [first, second]
      .map((result) => JSON.parse(result.stdout.trim()) as { status: string })
      .map((parsed) => parsed.status)
      .sort();
    expect(statuses).toEqual(['duplicate', 'enqueued']);

    expect(await dir.store.listRuns({ limit: 10, offset: 0 })).toHaveLength(1);
    expect((await dir.store.getRun(id))?.state).toBe('IDLE');
    expect(await dir.store.pendingCommands(id)).toHaveLength(1);
    await dir.store.close();
  }, 30_000);
});
