#!/usr/bin/env node
// PLAN §3 rule 8: agents never commit on this branch, so a gate's rollback point cannot be a commit.
// `node scripts/checkpoint.ts G<n>` writes, under $COHORTE_CHECKPOINT_DIR (which must lie OUTSIDE the
// repository):
//
//   <gate>-<utc timestamp>[-n]/
//     tracked.patch        git diff --binary HEAD   (index + working tree against HEAD, renames kept)
//     untracked.tar.gz     every untracked, non-ignored file
//     manifest.json        gate, HEAD, branch, counts, sha256 of both artifacts, how to restore
//
// It only READS the repository: no commit, no ref, no stash, no index refresh (GIT_OPTIONAL_LOCKS=0).
//
// Restore, from a clean checkout of `head`:
//   git apply --index --binary <dir>/tracked.patch && tar -xzf <dir>/untracked.tar.gz

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

export class CheckpointError extends Error {}

export interface CheckpointOptions {
  root: string;
  gate: string;
  /** Normally `process.env.COHORTE_CHECKPOINT_DIR`. */
  checkpointDir: string | undefined;
  now?: Date;
  /** Environment for git and tar; tests pass a hermetic one. */
  env?: NodeJS.ProcessEnv;
}

export interface CheckpointResult {
  dir: string;
  trackedFiles: number;
  untrackedFiles: number;
}

/** Canonical form of a path that may not exist yet: the deepest existing ancestor is resolved, the rest appended. */
function canonical(path: string): string {
  const missing: string[] = [];
  let existing = path;
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...missing);
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export function takeCheckpoint(options: CheckpointOptions): CheckpointResult {
  const { gate, checkpointDir } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(gate))
    throw new CheckpointError(`invalid gate name ${JSON.stringify(gate)}: expected something like G0`);
  if (checkpointDir === undefined || checkpointDir === '') {
    throw new CheckpointError(
      'COHORTE_CHECKPOINT_DIR is not set: checkpoints are written outside the repository, never inside it',
    );
  }
  if (!isAbsolute(checkpointDir))
    throw new CheckpointError(`COHORTE_CHECKPOINT_DIR must be an absolute path, got ${checkpointDir}`);

  const env = { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: '0' };
  const git = (args: string[], input?: Buffer) => {
    const done = spawnSync('git', args, { cwd: options.root, env, input, maxBuffer: 1024 * 1024 * 1024 });
    if (done.status !== 0)
      throw new CheckpointError(`git ${args.join(' ')} failed: ${done.stderr?.toString() ?? done.error}`);
    return done.stdout;
  };

  const root = realpathSync(git(['rev-parse', '--show-toplevel']).toString().trim());
  const target = canonical(checkpointDir);
  const inside = relative(root, target);
  if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) {
    throw new CheckpointError(
      `COHORTE_CHECKPOINT_DIR (${target}) is inside the repository (${root}): a checkpoint must survive \`git clean\` and a deleted tree`,
    );
  }

  const head = git(['rev-parse', 'HEAD']).toString().trim();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
  const patch = git(['diff', '--binary', '--find-renames', 'HEAD']);
  const trackedFiles = git(['diff', '--name-only', '-z', 'HEAD']).toString().split('\0').filter(Boolean);
  const untrackedList = git(['ls-files', '--others', '--exclude-standard', '-z']);
  const untrackedFiles = untrackedList.toString().split('\0').filter(Boolean).sort();

  const stamp = (options.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  let dir = join(target, `${gate}-${stamp}`);
  for (let n = 2; existsSync(dir); n += 1) dir = join(target, `${gate}-${stamp}-${n}`);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'tracked.patch'), patch);
  const tarball = join(dir, 'untracked.tar.gz');
  // `-T -` with --null reads the NUL-separated list from stdin: file names with spaces or newlines survive.
  const tar = spawnSync('tar', ['-czf', tarball, '--null', '-T', '-'], { cwd: root, env, input: untrackedList });
  if (tar.status !== 0) throw new CheckpointError(`tar failed: ${tar.stderr?.toString() ?? tar.error}`);

  const manifest = {
    gate,
    createdAt: (options.now ?? new Date()).toISOString(),
    repository: root,
    head,
    branch,
    tracked: { file: 'tracked.patch', files: trackedFiles.length, sha256: sha256(patch) },
    untracked: { file: 'untracked.tar.gz', files: untrackedFiles, sha256: sha256(readFileSync(tarball)) },
    restore: [`git checkout ${head}`, 'git apply --index --binary tracked.patch', 'tar -xzf untracked.tar.gz'],
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, trackedFiles: trackedFiles.length, untrackedFiles: untrackedFiles.length };
}

function main(): number {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' } } });
  const [gate] = positionals;
  if (gate === undefined || positionals.length !== 1) {
    process.stderr.write(
      'usage: COHORTE_CHECKPOINT_DIR=<absolute dir outside the repo> node scripts/checkpoint.ts <gate> [--root <dir>]\n',
    );
    return 2;
  }
  try {
    const result = takeCheckpoint({
      root: resolve(values.root ?? join(import.meta.dirname, '..')),
      gate,
      checkpointDir: process.env.COHORTE_CHECKPOINT_DIR,
    });
    process.stdout.write(
      `checkpoint ${gate}: ${result.trackedFiles} tracked change(s), ${result.untrackedFiles} untracked file(s)\n${result.dir}\n`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof CheckpointError)) throw error;
    process.stderr.write(`checkpoint: ${error.message}\n`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = main();
