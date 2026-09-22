import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfig, type Run } from './contracts.ts';
import { git } from './process.ts';
import { Store } from './store.ts';

export async function project(directory: string, stateRoot?: string) {
  const repo = await realpath(await git(directory, ['rev-parse', '--show-toplevel']));
  const key = createHash('sha256').update(repo).digest('hex').slice(0, 20);
  const state = join(stateRoot ?? join(homedir(), '.cohorte-next'), key);
  if (state === repo || state.startsWith(`${repo}/`)) throw new Error('State must live outside the source repository');
  await mkdir(state, { recursive: true, mode: 0o700 });
  return { repo, state, store: new Store(join(state, 'state.sqlite')) };
}
export async function createRun(
  repo: string,
  state: string,
  configPath: string,
  specPath: string,
  store: Store,
): Promise<Run> {
  const config = parseConfig(JSON.parse(await readFile(resolve(configPath), 'utf8')));
  const spec = await readFile(resolve(specPath), 'utf8');
  if (!spec.trim() || Buffer.byteLength(spec) > 64 * 1024) throw new Error('Spec must contain 1–65536 bytes');
  // A run starts from a committed, inspectable snapshot, never silently drops dirty edits.
  if (await git(repo, ['status', '--porcelain']))
    throw new Error('Source repository is dirty; commit or use a clean checkout before starting');
  const id = randomUUID();
  const branch = `cohorte-next/${id}`;
  const worktree = join(state, 'worktrees', id);
  await mkdir(join(state, 'worktrees'), { recursive: true });
  await git(repo, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
  const run: Run = {
    id,
    repo,
    worktree,
    branch,
    spec,
    config,
    phase: 'build',
    status: 'pending',
    round: 0,
    feedback: '',
    summary: '',
    checks: [],
    threadIds: [],
  };
  store.create(run);
  store.event(id, 'run.created', branch);
  return run;
}
export async function lockRun(state: string, id: string, acknowledgeStale = false) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid run id');
  const path = join(state, `${id}.lock`);
  const token = randomUUID();
  const acquire = async () => {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid, token }));
      await file.sync();
    } finally {
      await file.close();
    }
  };
  try {
    await acquire();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Serialize stale-lock reclamation so two resumers cannot unlink each other's new lock.
    const reclaimPath = `${path}.reclaim`;
    const reclaim = await open(reclaimPath, 'wx', 0o600).catch(() => {
      throw new Error('Run lock recovery already active; inspect stale recovery files if needed');
    });
    try {
      const previous = JSON.parse(await readFile(path, 'utf8')) as { pid: number };
      if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('Invalid run lock; inspect it manually');
      let active = true;
      try {
        process.kill(previous.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') active = false;
      }
      if (active) throw new Error('Run already active (or lock PID reused); refusing concurrent execution');
      if (!acknowledgeStale)
        throw new Error('Previous controller died. Inspect the worktree and resume with --acknowledge-uncertain');
      await unlink(path);
      await acquire();
    } finally {
      await reclaim.close();
      await unlink(reclaimPath);
    }
  }
  return async () => {
    const current = JSON.parse(await readFile(path, 'utf8')) as { token: string };
    if (current.token === token) await unlink(path);
  };
}
