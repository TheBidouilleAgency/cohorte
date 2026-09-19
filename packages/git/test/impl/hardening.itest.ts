// DESIGN 5.0: the hardened invocation is "mandatory on EVERY Cohorte-run git invocation". These tests observe the
// real argv of every child process a `GitPort` method spawns, through a shim that records `"$@"` and then execs the
// real git — so the guarantee is pinned on the invocations themselves, not on the literals written in the sources.
// (A contract change to GIT_PORCELAIN_ARGS / GIT_DIFF_HARDENING_ARGS that failed to reach the runner fails here.)
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import {
  type CanonicalPath,
  GIT_DIFF_HARDENING_ARGS,
  GIT_HARDENED_CONFIG_ARGS,
  GIT_PORCELAIN_ARGS,
  type SurfaceMap,
} from '../../src/contract.ts';
import { AGENT_IDENTITY, testGitPort } from './helpers.ts';

/** One record per invocation: its args NUL-separated, the record closed by RS (0x1e). */
const RECORD_SEP = '\u001e';

async function makeGitShim(dir: string): Promise<{ gitBinary: string; invocations: () => Promise<string[][]> }> {
  await mkdir(dir, { recursive: true });
  const log = join(dir, 'argv.log');
  const shim = join(dir, 'git-shim.sh');
  await writeFile(
    shim,
    `#!/bin/sh\n{\nfor arg in "$@"; do printf '%s\\0' "$arg"; done\nprintf '\\036'\n} >> '${log}'\nexec git "$@"\n`,
  );
  await chmod(shim, 0o755);
  return {
    gitBinary: shim,
    invocations: async () => {
      const raw = await readFile(log, 'utf8').catch(() => '');
      return raw
        .split(RECORD_SEP)
        .filter((record) => record !== '')
        .map((record) => record.split('\0').slice(0, -1));
    },
  };
}

/** The subcommand of one recorded invocation: what follows the mandatory hardened `-c` prefix. */
const subcommandOf = (argv: string[]): string => argv[GIT_HARDENED_CONFIG_ARGS.length] ?? '';

describe('DESIGN 5.0 on every invocation', () => {
  test('every git child carries the hardened -c prefix, and every diff/status its mandatory flags', async ({
    tempRepo,
    tempDir,
  }) => {
    const shim = await makeGitShim(join(tempDir, 'shim'));
    const port = testGitPort({ gitBinary: shim.gitBinary, worktreeRoot: tempDir as CanonicalPath });
    const repo = tempRepo.root as CanonicalPath;

    // A spread of methods, chosen so that `status`, `diff` and a parsed porcelain output all occur.
    await tempRepo.write('kept.txt', 'v1\n');
    const base = await tempRepo.commit('base');
    await writeFile(join(tempRepo.root, 'kept.txt'), 'v2\n');
    await writeFile(join(tempRepo.root, 'added.txt'), 'new\n');
    await port.facts(repo);
    await port.changedPaths(repo);
    await port.treeDigest(repo, { exclude: ['.cohorte'] });
    const committed = await port.commitAll({
      worktree: repo,
      message: 'cohorte(spec): surface build#1',
      trailers: { 'Cohorte-Run': 'run-1' },
      identity: AGENT_IDENTITY,
      paths: ['kept.txt', 'added.txt'],
    });
    expect(committed).not.toEqual({ kind: 'nothing' });
    const surfaces: SurfaceMap = { surfaceOf: () => 'shared' };
    await port.diffBySurface({ repo, base, head: 'HEAD', surfaces });
    await port.removeWorktree(join(tempDir, 'absent') as CanonicalPath, { force: false }).catch(() => undefined);

    const invocations = await shim.invocations();
    expect(invocations.length).toBeGreaterThan(8);
    const diffs = invocations.filter((argv) => subcommandOf(argv) === 'diff');
    const statuses = invocations.filter((argv) => subcommandOf(argv) === 'status');
    expect(diffs.length).toBeGreaterThan(1);
    expect(statuses.length).toBeGreaterThan(0);

    for (const argv of invocations) {
      expect(argv.slice(0, GIT_HARDENED_CONFIG_ARGS.length)).toEqual([...GIT_HARDENED_CONFIG_ARGS]);
    }
    for (const argv of diffs) {
      for (const flag of GIT_DIFF_HARDENING_ARGS) expect(argv).toContain(flag);
    }
    for (const argv of statuses) {
      for (const flag of GIT_PORCELAIN_ARGS) expect(argv).toContain(flag);
    }
  });
});
