// S-70 (DESIGN 5.0, 7.4): a husky-style fixture (`core.hooksPath=.husky/_`, a gitignored hook writing a canary)
// goes through commit, worktree add and a plumbing merge. The canary must never appear: every GitPort call sets
// `-c core.hooksPath=/dev/null` on the command line, which always outranks repository config.
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import type { CanonicalPath } from '../../src/contract.ts';
import { AGENT_IDENTITY, testGitPort } from './helpers.ts';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const HOOK_NAMES = ['pre-commit', 'post-commit', 'post-checkout', 'post-merge', 'pre-push'];

/** Hooks a git hook implementation never needs to be TRACKED to run: git reads `core.hooksPath` straight off disk. */
async function plantHuskyHooks(repoRoot: string, canaryFile: string): Promise<void> {
  const hooksDir = join(repoRoot, '.husky', '_');
  await mkdir(hooksDir, { recursive: true });
  await writeFile(join(repoRoot, '.gitignore'), '.husky/\n');
  for (const name of HOOK_NAMES) {
    const script = `#!/bin/sh\nprintf '%s\\n' "${name}" >> ${JSON.stringify(canaryFile)}\nexit 0\n`;
    const path = join(hooksDir, name);
    await writeFile(path, script);
    await chmod(path, 0o755);
  }
}

describe('S-70 hook canary', () => {
  test('commit, worktree add and a plumbing merge never run a repo-configured hook', async ({ tempRepo, tempDir }) => {
    const canaryFile = join(tempDir, 'canary.txt');
    await plantHuskyHooks(tempRepo.root, canaryFile);
    // core.hooksPath is a REPOSITORY config: set it directly (never through our own hardened runner).
    await tempRepo.git(['config', 'core.hooksPath', '.husky/_']);

    const port = testGitPort();
    const repo = tempRepo.root as CanonicalPath;

    // 1. worktree add (would fire post-checkout in vanilla git).
    const wtPath = join(tempDir, 'wt') as CanonicalPath;
    await port.addWorktree({ repo, path: wtPath, branch: 'agent-branch', commit: await tempRepo.head() });

    // 2. commitAll in the new worktree (would fire pre-commit/post-commit).
    await writeFile(join(wtPath, 'work.txt'), 'agent work\n');
    const committed = await port.commitAll({
      worktree: wtPath,
      message: 'agent work',
      trailers: { 'Cohorte-Run': 'run_test' },
      identity: AGENT_IDENTITY,
      paths: ['work.txt'],
    });
    expect('kind' in committed).toBe(false);

    // 3. plumbing merge into a second branch (post-merge never applies to plumbing, asserted anyway).
    const theirBranch = await tempRepo.git(['rev-parse', 'HEAD']);
    const merged = await port.mergeTree(repo, 'agent-branch', theirBranch.stdout.trim());
    expect(merged.clean).toBe(true);
    if (merged.clean) {
      const sha = await port.commitTree(repo, merged.tree, ['agent-branch', theirBranch.stdout.trim()], 'merge', {});
      const cas = await port.updateRefCas(repo, 'refs/cohorte/test/integration', sha, null);
      expect(cas).toBe('ok');
    }

    expect(await exists(canaryFile)).toBe(false);
  });
});
