import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lockRun } from '../src/project.ts';
import { executeRun } from '../src/workflow.ts';
import { fixture } from './helpers.ts';

test('SIGKILL leaves durable running state; stale lock requires explicit phase restart', {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./crash-child.ts', import.meta.url)), join(f.root, 'state/db.sqlite'), f.root, f.run.id],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const closed = once(child, 'close');
  try {
    const [ready] = await once(child.stdout, 'data');
    assert.match(String(ready), /READY/);
    child.kill('SIGKILL');
    await closed;
    const run = f.store.get(f.run.id);
    assert.equal(run.status, 'running');
    assert.equal(run.phase, 'build');
    await assert.rejects(lockRun(f.root, run.id), /acknowledge/);
    const release = await lockRun(f.root, run.id, true);
    try {
      let agents = 0;
      await executeRun(
        run,
        f.store,
        {
          async execute() {
            agents++;
            return { verdict: 'pass', summary: 'Restarted', findings: [] };
          },
        },
        {
          async execute() {
            return [{ argv: ['fixture'], exitCode: 0, output: '' }];
          },
        },
        new AbortController().signal,
      );
      assert.equal(run.status, 'completed');
      assert.equal(agents, 2);
    } finally {
      await release();
    }
  } finally {
    child.kill('SIGKILL');
    await closed;
    await f.cleanup();
  }
});
