import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { DockerChecks } from '../src/checks.ts';
import { CodexRuntime } from '../src/codex.ts';
import { executeRun } from '../src/workflow.ts';
import { fixture } from './helpers.ts';
import { answer, call, synthetic } from './synthetic.ts';

const binary = process.env.COHORTE_CODEX_BINARY ?? 'codex';
test('REAL Codex: abort before an admitted tool prevents the write', { timeout: 30_000 }, async () => {
  const f = await fixture();
  const model = await synthetic(f.root, () =>
    call('cohorte_write', { path: 'src/add.js', content: 'must not be written' }),
  );
  const stop = new AbortController();
  try {
    await assert.rejects(
      new CodexRuntime({ binary, fixture: model.options }).execute({
        run: f.run,
        phase: 'build',
        signal: stop.signal,
        onThread() {},
        onEvent(kind) {
          if (kind === 'tool.requested') stop.abort();
        },
      }),
      /interrupted/,
    );
    assert((await readFile(join(f.workspace, 'src/add.js'), 'utf8')).includes('a - b'));
  } finally {
    await model.close();
    await f.cleanup();
  }
});
test('REAL Codex: dynamic file tools, refused native secret read, Docker test failure/fix/review', {
  timeout: 120_000,
}, async () => {
  const f = await fixture();
  await mkdir(join(f.workspace, 'test'));
  await writeFile(
    join(f.workspace, 'test/add.test.js'),
    `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {add} from '../src/add.js'; test('sum',()=>assert.equal(add(2,3),5));`,
  );
  const script = [
    call('exec_command', { cmd: `cat ${join(f.root, 'codex/synthetic-private')}`, max_output_tokens: 1000 }),
    call('cohorte_list', {}),
    call('cohorte_read', { path: 'src/add.js' }),
    answer({ verdict: 'pass', summary: 'Build ready (deliberately buggy fixture)', findings: [] }),
    call('cohorte_write', { path: 'src/add.js', content: 'export const add = (a,b) => a+b;\n' }),
    answer({ verdict: 'pass', summary: 'Fixed addition', findings: [] }),
    call('cohorte_write', { path: 'src/add.js', content: 'reviewer corruption' }),
    call('cohorte_read', { path: 'src/add.js' }),
    answer({ verdict: 'pass', summary: 'Reviewed addition', findings: [] }),
  ];
  const model = await synthetic(
    f.root,
    (_body, n) =>
      script[n - 1] ?? answer({ verdict: 'fix', summary: 'Unexpected request', findings: ['Fixture exhausted'] }),
  );
  try {
    const runtime = new CodexRuntime({ binary, fixture: model.options });
    await executeRun(f.run, f.store, runtime, new DockerChecks(), new AbortController().signal);
    assert.equal(f.run.status, 'completed', f.run.summary);
    assert.equal(f.run.round, 1);
    assert.equal(f.run.threadIds.length, 3);
    assert.equal(f.run.checks[0]?.exitCode, 0);
    assert.match(await readFile(join(f.workspace, 'src/add.js'), 'utf8'), /a\+b/);
    assert(!JSON.stringify(model.requests).includes('SECRET_SHOULD_NEVER_REACH_MODEL'));
    assert(f.store.events(f.run.id).some((e) => e.kind === 'native.effects.denied' && Number(e.detail) > 0));
    const reviewCalls = model.requests.slice(6);
    assert(reviewCalls.every((r) => !JSON.stringify(r.tools).includes('cohorte_write')));
    assert(JSON.stringify(reviewCalls.map((r) => r.input)).includes('unsupported'));
    console.log(
      JSON.stringify({
        native: '0.155.1',
        requests: model.requests.length,
        status: f.run.status,
        round: f.run.round,
        checks: f.run.checks.map((c) => c.exitCode),
        secretRead: 'denied',
        reviewerWrite: 'denied',
      }),
    );
  } finally {
    await model.close();
    await f.cleanup();
  }
});

test('REAL Docker: no credential/state mount, readonly workspace, network isolation, cancellation cleanup', {
  timeout: 60_000,
}, async () => {
  const f = await fixture();
  try {
    f.run.config.checks = [
      [
        'node',
        '-e',
        `const fs=require('fs'); if(process.env.OPENAI_API_KEY||process.env.CODEX_HOME)process.exit(2);try{fs.writeFileSync('/workspace/src/add.js','bad');process.exit(3)}catch{}; try{fs.readFileSync(${JSON.stringify(join(f.root, 'state/db.sqlite'))});process.exit(4)}catch{}; if(Object.keys(require('os').networkInterfaces()).some(n=>n!=='lo'))process.exit(5); console.log('isolated');`,
      ],
    ];
    const results = await new DockerChecks().execute(f.run, new AbortController().signal);
    assert.equal(results[0]?.exitCode, 0, results[0]?.output);
    f.run.config.checks = [['node', '-e', 'setInterval(()=>{},1000)']];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 1000);
    try {
      await assert.rejects(new DockerChecks().execute(f.run, abort.signal), /interrupted/);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await f.cleanup();
  }
});
