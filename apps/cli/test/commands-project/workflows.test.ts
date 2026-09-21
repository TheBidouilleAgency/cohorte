import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import alignDs from '../../src/commands/align-ds/index.ts';
import audit from '../../src/commands/audit/index.ts';
import fleet from '../../src/commands/fleet/index.ts';
import loop from '../../src/commands/loop/index.ts';
import { decideLoop } from '../../src/commands/loop/reducer.ts';
import refactor from '../../src/commands/refactor/index.ts';
import retro from '../../src/commands/retro/index.ts';
import updatePipeline from '../../src/commands/update-pipeline/index.ts';
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
          send: async (_command: string, payload: unknown) => {
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

  test('align-ds consumes a configured live filesystem adapter and refreshes the snapshot', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-ds-live-'));
    try {
      await mkdir(join(cwd, 'live'), { recursive: true });
      await mkdir(join(cwd, 'snapshot'), { recursive: true });
      await mkdir(join(cwd, 'ui'), { recursive: true });
      await writeFile(join(cwd, 'tokens.css'), ':root {}\n');
      await writeFile(join(cwd, 'live', 'Button.prompt.md'), 'live button\n');
      await writeFile(join(cwd, 'snapshot', 'Button.prompt.md'), 'old button\n');
      await writeFile(join(cwd, 'ui', 'Button.prompt.md'), 'old button\n');
      await writeFile(
        join(cwd, 'PIPELINE.md'),
        [
          '```yaml pipeline-profile',
          'design:',
          '  enabled: true',
          '  live_snapshot_dir: live',
          '  snapshot_dir: snapshot',
          '  ui_kit_path: ui',
          '  tokens_path: tokens.css',
          '```',
          '',
        ].join('\n'),
      );
      const out = captureStream();
      const ctx = fakeCliContext({ cwd, stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin } });
      expect(await alignDs.run(ctx, { positionals: [], options: {}, json: true })).toBe(0);
      expect(JSON.parse(out.text())).toMatchObject({ source: join(cwd, 'live'), delta: 1 });
      expect(await alignDs.run(ctx, { positionals: ['--apply'], options: {}, json: false })).toBe(0);
      await expect(readFile(join(cwd, 'snapshot', 'Button.prompt.md'), 'utf8')).resolves.toBe('live button\n');
      await expect(readFile(join(cwd, 'ui', 'Button.prompt.md'), 'utf8')).resolves.toBe('live button\n');
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

  test('update-pipeline verifies the Pi bundle before planning reconciliation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-update-pipeline-'));
    try {
      const out = captureStream();
      const ctx = fakeCliContext({
        cwd,
        stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
        assets: { verify: async () => ({ ok: true }), bundleManifest: async () => [] } as never,
        install: { installDir: () => '/tmp/cohorte-install', bundleManifest: async () => [] } as never,
      });
      expect(await updatePipeline.run(ctx, { positionals: ['--plan'], options: {}, json: true })).toBe(0);
      const lines = out.text().trim().split('\n');
      expect(JSON.parse(lines.at(-1) ?? '')).toMatchObject({ mode: 'plan', bundleVerified: true, bundleFiles: 0 });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('refactor records per-domain Pi outcomes and leaves pending items open', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-refactor-'));
    try {
      await mkdir(join(cwd, 'specs'), { recursive: true });
      await writeFile(
        join(cwd, 'specs', 'refactor-backlog.md'),
        '# Refactor backlog\n\n## apps-api\n\n- [ ] HIGH · apps/api/auth.ts:12 · tdd · add a regression test\n- [ ] HIGH · apps/api/auth.ts:20 · tdd · cover logout\n- [ ] MEDIUM · apps/api/auth.ts:30 · tdd · cover timeout\n- [ ] MEDIUM · apps/api/auth.ts:40 · tdd · remove duplication\n- [ ] LOW · apps/api/auth.ts:50 · cleanup · rename helper\n',
      );
      const out = captureStream();
      const ctx = fakeCliContext({
        cwd,
        stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
        controller: { send: async () => ({ status: 'pending', result: { runId: 'run_refactor' } }) } as never,
        hostSpawner: { spawnDetached: async () => ({ pid: 1 }) } as never,
      });
      expect(await refactor.run(ctx, { positionals: ['apps-api'], options: {}, json: false })).toBe(4);
      expect(JSON.parse(await readFile(join(cwd, 'specs', 'reports', 'refactor.json'), 'utf8'))).toMatchObject({
        outcomes: [{ domain: 'apps-api', status: 4, attempts: 1 }],
      });
      await expect(readFile(join(cwd, 'specs', 'refactor-backlog.md'), 'utf8')).resolves.toContain('- [ ]');
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

  test('loop ignores a verdict older than the current spec', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-loop-stale-'));
    try {
      await mkdir(join(cwd, 'specs', 'reports'), { recursive: true });
      const verdict = join(cwd, 'specs', 'reports', 'feature-x.verdict.json');
      const spec = join(cwd, 'specs', 'feature-x.md');
      await writeFile(
        verdict,
        JSON.stringify({
          verdict: 'approved',
          unreviewed: [],
          deferred: [],
          blockingItems: [],
          blocking: 0,
          clean: true,
        }),
      );
      await writeFile(spec, '---\nstatus: frozen\n---\n');
      const old = new Date(Date.now() - 60_000);
      await utimes(verdict, old, old);
      const out = captureStream();
      const ctx = fakeCliContext({
        cwd,
        stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
        controller: { send: async () => ({ status: 'completed' }) } as never,
      });
      expect(await loop.run(ctx, { positionals: ['feature-x'], options: {}, json: true })).toBe(0);
      expect(JSON.parse(await readFile(join(cwd, 'specs', 'reports', 'feature-x.loop.json'), 'utf8'))).toMatchObject({
        outcome: 'abort',
        reason: 'review-died',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('loop resumes an active persisted run instead of enqueueing a duplicate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cohorte-loop-resume-'));
    try {
      await mkdir(join(cwd, 'specs', 'reports'), { recursive: true });
      await writeFile(
        join(cwd, 'specs', 'reports', 'feature-x.loop.json'),
        JSON.stringify({
          id: 'feature-x',
          round: 1,
          maxRounds: 3,
          phase: 'build',
          status: 'pending',
          runId: 'run_existing',
          startedAt: '2026-09-18T00:00:00.000Z',
          updatedAt: '2026-09-18T00:00:00.000Z',
        }),
      );
      const out = captureStream();
      const ctx = fakeCliContext({
        cwd,
        stdio: { stdout: out.stream, stderr: out.stream, stdin: process.stdin },
        controller: {
          send: async () => {
            throw new Error('duplicate start');
          },
        } as never,
        openStore: async () =>
          ({
            readRunTree: async () => ({ run: { state: 'BUILD' } }),
            close: async () => {},
          }) as never,
      });
      expect(await loop.run(ctx, { positionals: ['feature-x'], options: {}, json: true })).toBe(4);
      expect(JSON.parse(out.text())).toMatchObject({ status: 'pending', runId: 'run_existing' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
