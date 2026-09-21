import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import alignDs from '../../src/commands/align-ds/index.ts';
import audit from '../../src/commands/audit/index.ts';
import fleet from '../../src/commands/fleet/index.ts';
import loop from '../../src/commands/loop/index.ts';
import { decideLoop } from '../../src/commands/loop/reducer.ts';
import retro from '../../src/commands/retro/index.ts';
import { captureStream, fakeCliContext } from '../registry/helpers.ts';

describe('V2 workflow compatibility commands', () => {
  test('loop reducer ships only on a clean reviewed result', () => {
    expect(decideLoop(null, undefined, 1, 5)).toEqual({ outcome: 'abort', reason: 'review-died' });
    expect(
      decideLoop(
        {
          verdict: 'findings',
          kept: [],
          refuted: [],
          deferred: [],
          needsInvestigation: [],
          blocking: 1,
          blockingItems: ['apps/api/auth.ts:12'],
          fingerprint: '0000000000000000',
          unreviewed: [],
          clean: false,
          counts: { critical: 0, major: 1, minor: 0, info: 0 },
        },
        'apps/api/auth.ts:12',
        2,
        5,
      ),
    ).toEqual({ outcome: 'abort', reason: 'treading-water' });
  });

  test('audit materializes a durable backlog from prior structured reports', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-audit-'));
    try {
      await mkdir(join(cwd, 'specs', 'reports'), { recursive: true });
      await writeFile(
        join(cwd, 'specs', 'reports', 'review.json'),
        JSON.stringify({
          items: [{ severity: 'HIGH', file: 'apps/api/auth.ts', line: 12, kind: 'tdd', fix: 'add a regression test' }],
        }),
      );
      const out = captureStream();
      const ctx = fakeCliContext({
        cwd,
        stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
        controller: { send: async () => ({ status: 'pending' }) } as never,
      });
      expect(await audit.run(ctx, { positionals: [], options: {}, json: false })).toBe(4);
      await expect(readFile(join(cwd, 'specs', 'refactor-backlog.md'), 'utf8')).resolves.toContain(
        'HIGH · apps/api/auth.ts:12 · tdd · add a regression test',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('audit dispatches one Pi review per configured domain and records the dispatch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-audit-dispatch-'));
    try {
      await writeFile(
        join(cwd, 'PIPELINE.md'),
        ['```yaml pipeline-profile', 'surfaces:', '  - key: apps-api', '  - key: apps-web', '```', ''].join('\n'),
      );
      const calls: unknown[] = [];
      const out = captureStream();
      const ctx = fakeCliContext({
        cwd,
        stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
        controller: {
          send: async (_command, payload) => {
            calls.push(payload);
            return { status: 'pending' };
          },
        } as never,
      });
      expect(await audit.run(ctx, { positionals: [], options: {}, json: false })).toBe(4);
      expect(calls).toHaveLength(3);
      expect(calls.map((payload) => (payload as { surfaces?: string[] }).surfaces)).toEqual([
        ['apps-api'],
        ['apps-web'],
        ['shared'],
      ]);
      await expect(readFile(join(cwd, 'specs', 'reports', 'audit-dispatch.json'), 'utf8')).resolves.toContain(
        '"deadDomains": []',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('retro mines repeated findings and only writes after explicit ratification', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-retro-'));
    try {
      await mkdir(join(cwd, 'specs', 'reports'), { recursive: true });
      await writeFile(join(cwd, 'specs', 'reports', 'a.verdict.json'), 'HIGH apps/api/auth.ts:10 add authorization\n');
      await writeFile(join(cwd, 'specs', 'reports', 'b.verdict.json'), 'HIGH apps/api/auth.ts:10 add authorization\n');
      const out = captureStream();
      const ctx = fakeCliContext({ cwd, stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
      expect(await retro.run(ctx, { positionals: [], options: {}, json: true })).toBe(0);
      expect(JSON.parse(out.text()).patterns).toHaveLength(1);
      expect(
        await retro.run(ctx, {
          positionals: ['--apply', '--rule', 'Every auth route must authorize before handling'],
          options: {},
          json: false,
        }),
      ).toBe(0);
      await expect(readFile(join(cwd, 'PIPELINE.md'), 'utf8')).resolves.toContain('Every auth route');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('align-ds is a no-op when the project has no design system', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-ds-'));
    try {
      const out = captureStream();
      const ctx = fakeCliContext({ cwd, stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
      expect(await alignDs.run(ctx, { positionals: [], options: {}, json: false })).toBe(0);
      expect(out.text()).toContain('disabled');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('fleet plan requires frozen specs and persists an explicit plan', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-fleet-'));
    try {
      await mkdir(join(cwd, 'specs'), { recursive: true });
      await writeFile(join(cwd, 'specs', 'one.md'), '---\nstatus: frozen\n---\n');
      await writeFile(join(cwd, 'specs', 'two.md'), '---\nstatus: frozen\n---\n');
      const out = captureStream();
      const ctx = fakeCliContext({ cwd, stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
      expect(
        await fleet.run(ctx, { subVerb: 'plan', positionals: ['one', 'two', '--apply'], options: {}, json: false }),
      ).toBe(0);
      await expect(readFile(join(cwd, 'specs', 'reports', 'fleet.json'), 'utf8')).resolves.toContain('one');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('fleet sync drops an explicitly shipped feature without touching its worktree', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-fleet-sync-'));
    try {
      await mkdir(join(cwd, 'specs', 'reports'), { recursive: true });
      await writeFile(
        join(cwd, 'specs', 'reports', 'fleet.json'),
        JSON.stringify({ order: ['one', 'two'], features: { one: { worktree: '/missing/one' }, two: {} } }),
      );
      const out = captureStream();
      const ctx = fakeCliContext({ cwd, stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
      expect(await fleet.run(ctx, { subVerb: 'sync', positionals: ['one'], options: {}, json: true })).toBe(0);
      await expect(readFile(join(cwd, 'specs', 'reports', 'fleet.json'), 'utf8')).resolves.not.toContain('"one"');
      expect(JSON.parse(out.text()).rows[0]).toMatchObject({ id: 'one', action: 'shipped: removed from fleet plan' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('loop persists a resumable durable handoff and refuses to ship without a verdict', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-loop-'));
    try {
      const out = captureStream();
      const ctx = fakeCliContext({
        cwd,
        stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
        controller: { send: async () => ({ status: 'pending', result: { runId: 'run_loop' } }) } as never,
        hostSpawner: { spawnDetached: async () => {} } as never,
      });
      expect(await loop.run(ctx, { positionals: ['feature-x', '--max-rounds', '3'], options: {}, json: true })).toBe(4);
      const report = JSON.parse(await readFile(join(cwd, 'specs', 'reports', 'feature-x.loop.json'), 'utf8')) as {
        id: string;
        round: number;
        maxRounds: number;
        status: string;
        phase: string;
      };
      expect(report).toMatchObject({ id: 'feature-x', round: 1, maxRounds: 3, status: 'pending', phase: 'build' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
