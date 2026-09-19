// DESIGN 5.0: the hardened invocation itself, independent of any one GitPort method.
import { test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import { GitCommandError, runGit } from '../../src/impl/runner.ts';

const options = () => ({ gitBinary: 'git', path: process.env.PATH ?? '/usr/bin:/bin' });

describe('runGit', () => {
  test('GIT_CONFIG_GLOBAL=/dev/null: no global config is ever read, whatever the real HOME holds', async ({
    tempRepo,
  }) => {
    const result = await runGit({
      ...options(),
      cwd: tempRepo.root,
      args: ['config', '--global', '--get', 'user.name'],
      allowExitCodes: [1],
    });
    expect(result.exitCode).toBe(1); // "key not found" — /dev/null has no [user] section, whatever ~/.gitconfig says
  });

  test('rejects with GitCommandError, carrying args/stderr/exitCode, on a non-zero exit', async ({ tempRepo }) => {
    await expect(runGit({ ...options(), cwd: tempRepo.root, args: ['this-is-not-a-git-command'] })).rejects.toThrow(
      GitCommandError,
    );
    try {
      await runGit({ ...options(), cwd: tempRepo.root, args: ['this-is-not-a-git-command'] });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError);
      const gitError = error as GitCommandError;
      expect(gitError.exitCode).not.toBeNull();
      expect(gitError.exitCode).not.toBe(0);
      expect(gitError.args).toContain('this-is-not-a-git-command');
    }
  });

  test('allowExitCodes resolves instead of rejecting, and reports the real exit code', async ({ tempRepo }) => {
    await tempRepo.write('a.txt', 'one\n');
    await tempRepo.commit('a');
    await tempRepo.write('b.txt', 'two\n');
    await tempRepo.git(['add', '-A']);
    const result = await runGit({
      ...options(),
      cwd: tempRepo.root,
      args: ['diff', '--cached', '--quiet'],
      allowExitCodes: [1],
    });
    expect(result.exitCode).toBe(1);
  });

  test('an explicit identity is used verbatim', async ({ tempRepo }) => {
    await runGit({
      ...options(),
      cwd: tempRepo.root,
      args: ['commit', '--allow-empty', '-q', '-m', 'x'],
      identity: { name: 'Explicit', email: 'explicit@example.invalid' },
    });
    const log = await tempRepo.git(['log', '-1', '--format=%an <%ae>']);
    expect(log.stdout.trim()).toBe('Explicit <explicit@example.invalid>');
  });
});
