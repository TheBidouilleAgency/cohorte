/** Explicit subscription-only smoke. Creates a disposable repository; no API fallback. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRuntime } from '../src/codex.ts';
import { command, git } from '../src/process.ts';
import { project } from '../src/project.ts';
import { config } from './helpers.ts';

const binary = process.env.COHORTE_CODEX_BINARY ?? 'codex';
const doctor = await new CodexRuntime({ binary }).doctor();
assert(doctor.subscription, 'Native ChatGPT subscription required; no API fallback');
const model = process.env.COHORTE_TEST_MODEL ?? doctor.models.find((m) => m.default)?.model ?? doctor.models[0]?.model;
assert(model, 'No native model available');
const root = await mkdtemp(join(tmpdir(), 'cohorte-live-'));
const repo = join(root, 'repo');
try {
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'test'));
  await writeFile(join(repo, 'package.json'), '{"type":"module"}');
  await writeFile(join(repo, 'src/add.js'), 'export const add = (a,b) => a-b;\n');
  await writeFile(
    join(repo, 'test/add.test.js'),
    `import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from '../src/add.js';test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1);assert.equal(add(0,0),0)});`,
  );
  await git(repo, ['init']);
  await git(repo, ['add', '.']);
  await git(repo, ['-c', 'user.name=Cohorte fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture']);
  const configPath = join(root, 'config.json');
  const spec = join(root, 'task.md');
  await writeFile(
    configPath,
    JSON.stringify({ ...config, codex: binary, model, writablePaths: ['src'], timeoutMs: 120_000 }),
  );
  await writeFile(
    spec,
    '# Fix addition\nChange src/add.js so add(a,b) returns a+b for positive, negative and zero arguments. Preserve the named export. Do not change tests.',
  );
  const result = await command(
    process.execPath,
    ['src/cli.ts', 'run', '--repo', repo, '--config', configPath, '--spec', spec, '--state-root', join(root, 'state')],
    {
      timeoutMs: 300_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
      },
    },
  );
  console.log(result.output);
  if (result.exitCode !== 0) {
    const first = JSON.parse(result.output.split('\n')[0] ?? '{}') as { runId: string };
    const p = await project(repo, join(root, 'state'));
    try {
      console.log(JSON.stringify({ events: p.store.events(first.runId), feedback: p.store.get(first.runId).feedback }));
    } finally {
      p.store.close();
    }
  }
  assert.equal(result.exitCode, 0, 'Subscription smoke did not complete');
  assert((await readFile(join(repo, 'src/add.js'), 'utf8')).includes('a-b'), 'Source checkout must remain untouched');
  console.log(JSON.stringify({ live: 'passed', model, authentication: 'native-chatgpt', sourceUntouched: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
