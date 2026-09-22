import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, Run } from '../src/contracts.ts';
import { Store } from '../src/store.ts';

export const config: Config = {
  model: 'synthetic',
  codex: 'codex',
  docker: 'docker',
  image: 'node:24-alpine',
  checks: [['node', '--test']],
  writablePaths: ['src', 'test'],
  maxRounds: 2,
  timeoutMs: 30_000,
};
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cohorte-test-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src/add.js'), 'export const add = (a, b) => a - b;\n');
  await writeFile(join(workspace, 'package.json'), '{"type":"module"}');
  const run: Run = {
    id: randomUUID(),
    repo: workspace,
    worktree: workspace,
    branch: 'fixture',
    spec: 'Make add(a,b) return the sum.',
    config: structuredClone(config),
    phase: 'build',
    status: 'pending',
    round: 0,
    feedback: '',
    checks: [],
    threadIds: [],
    summary: '',
  };
  const store = new Store(join(root, 'state/db.sqlite'));
  store.create(run);
  return {
    root,
    workspace,
    run,
    store,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
