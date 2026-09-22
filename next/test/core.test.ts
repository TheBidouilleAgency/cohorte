import assert from 'node:assert/strict';
import { link, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type AgentRuntime, parseConfig, parseVerdict } from '../src/contracts.ts';
import { Files } from '../src/files.ts';
import { lockRun } from '../src/project.ts';
import { Store } from '../src/store.ts';
import { executeRun } from '../src/workflow.ts';
import { config, fixture } from './helpers.ts';

test('file policy: valid edits, forbidden paths, read-only, symlinks and hardlinks', async () => {
  const f = await fixture();
  try {
    const files = new Files(f.workspace, ['src'], false);
    await files.write('src/add.js', 'export const add = (a,b) => a+b;');
    assert.match(await files.read('src/add.js'), /a\+b/);
    await files.write('src/nested/new.js', 'new');
    for (const path of [
      '../secret',
      '/tmp/secret',
      '.env',
      'src/../../secret',
      'src/.env',
      'src/key.pem',
      'src\\..\\secret',
      'test/file.js',
    ])
      await assert.rejects(files.write(path, 'bad'));
    const reviewer = new Files(f.workspace, ['src'], true);
    await assert.rejects(reviewer.write('src/add.js', 'bad'));
    await writeFile(join(f.root, 'secret'), 'PRIVATE');
    await symlink(join(f.root, 'secret'), join(f.workspace, 'src/link'));
    await link(join(f.root, 'secret'), join(f.workspace, 'src/hardlink'));
    await symlink(f.root, join(f.workspace, 'src/directory'));
    for (const path of ['src/link', 'src/hardlink', 'src/directory/secret']) {
      await assert.rejects(files.read(path));
      await assert.rejects(files.write(path, 'bad'));
    }
    assert.equal(await readFile(join(f.root, 'secret'), 'utf8'), 'PRIVATE');
    assert(!(await files.list()).includes('src/link'));
  } finally {
    await f.cleanup();
  }
});

test('configuration rejects empty checks, traversal and malformed verdicts', () => {
  assert.deepEqual(parseConfig(config), config);
  for (const change of [
    { checks: [] },
    { maxRounds: -1 },
    { writablePaths: ['../src'] },
    { writablePaths: ['.'] },
    { timeoutMs: 0 },
  ])
    assert.throws(() => parseConfig({ ...config, ...change }));
  for (const verdict of [
    { verdict: 'pass', summary: 'ok', findings: ['bug'] },
    { verdict: 'SHIP', summary: '', findings: [] },
    { verdict: 'pass', summary: '' },
  ])
    assert.throws(() => parseVerdict(verdict));
});

test('workflow actually repairs failing code, reruns checks and obtains independent review', async () => {
  const f = await fixture();
  const phases: string[] = [];
  const runtime: AgentRuntime = {
    async execute(task) {
      phases.push(task.phase);
      if (task.phase === 'fix') {
        assert.match(task.run.feedback, /exited 1/);
        await new Files(f.workspace, ['src'], false).write('src/add.js', 'export const add = (a,b) => a+b;');
      }
      return { verdict: 'pass', summary: task.phase, findings: [] };
    },
  };
  let checks = 0;
  try {
    const result = await executeRun(
      f.run,
      f.store,
      runtime,
      {
        async execute() {
          checks++;
          const body = await readFile(join(f.workspace, 'src/add.js'), 'utf8');
          return [{ argv: ['fixture'], exitCode: body.includes('a+b') ? 0 : 1, output: 'Expected addition' }];
        },
      },
      new AbortController().signal,
    );
    assert.equal(result.status, 'completed');
    assert.equal(result.round, 1);
    assert.deepEqual(phases, ['build', 'fix', 'review']);
    assert.equal(checks, 2);
    const reopened = new Store(join(f.root, 'state/db.sqlite'));
    assert.equal(reopened.get(result.id).status, 'completed');
    reopened.close();
  } finally {
    await f.cleanup();
  }
});

test('bounded review loop stops and never reruns build', async () => {
  const f = await fixture();
  const phases: string[] = [];
  try {
    await executeRun(
      f.run,
      f.store,
      {
        async execute({ phase }) {
          phases.push(phase);
          return {
            verdict: phase === 'review' ? 'fix' : 'pass',
            summary: 'Review',
            findings: phase === 'review' ? ['Missing criterion'] : [],
          };
        },
      },
      {
        async execute() {
          return [{ argv: ['test'], exitCode: 0, output: '' }];
        },
      },
      new AbortController().signal,
    );
    assert.equal(f.run.status, 'blocked');
    assert.equal(f.run.round, 2);
    assert.deepEqual(phases, ['build', 'review', 'fix', 'review', 'fix', 'review']);
  } finally {
    await f.cleanup();
  }
});

test('interruption persists current phase; explicit restart never pretends old effects were rolled back', async () => {
  const f = await fixture();
  const stop = new AbortController();
  try {
    await executeRun(
      f.run,
      f.store,
      {
        async execute() {
          stop.abort();
          throw new Error('Cancelled');
        },
      },
      {
        async execute() {
          throw new Error('Must not run');
        },
      },
      stop.signal,
    );
    assert.equal(f.store.get(f.run.id).status, 'interrupted');
    assert.equal(f.run.phase, 'build');
    assert.equal(f.store.events(f.run.id).at(-1)?.kind, 'run.interrupted');
  } finally {
    await f.cleanup();
  }
});

test('missing checks and agent failures cannot produce completed', async () => {
  const f = await fixture();
  try {
    await executeRun(
      f.run,
      f.store,
      {
        async execute() {
          return { verdict: 'pass', summary: '', findings: [] };
        },
      },
      {
        async execute() {
          return [];
        },
      },
      new AbortController().signal,
    );
    assert.equal(f.run.status, 'blocked');
    assert.equal(f.run.phase, 'test');
  } finally {
    await f.cleanup();
  }
});

test('run lock refuses concurrent owners and requires acknowledgement after controller death', async () => {
  const f = await fixture();
  try {
    const release = await lockRun(f.root, f.run.id);
    await assert.rejects(lockRun(f.root, f.run.id, true), /already active/);
    await release();
    await writeFile(join(f.root, `${f.run.id}.lock`), JSON.stringify({ pid: 2147483647, token: 'old' }));
    await assert.rejects(lockRun(f.root, f.run.id), /acknowledge/);
    const release2 = await lockRun(f.root, f.run.id, true);
    await release2();
  } finally {
    await f.cleanup();
  }
});

test('two simultaneous stale-lock recoveries cannot both acquire ownership', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, `${f.run.id}.lock`), JSON.stringify({ pid: 2147483647, token: 'old' }));
    const results = await Promise.allSettled([lockRun(f.root, f.run.id, true), lockRun(f.root, f.run.id, true)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const result of results) if (result.status === 'fulfilled') await result.value();
  } finally {
    await f.cleanup();
  }
});
