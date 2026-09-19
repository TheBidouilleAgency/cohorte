import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect } from 'vitest';
import { GIT_ENV, GIT_ENV_VARS, gitEnv, test } from '../../src/index.ts';

const run = promisify(execFile);

/** `git config --get` exits 1 when the key is unknown: that is the "not read" we are after. */
const configValue = async (key: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> => {
  try {
    const { stdout } = await run('git', ['config', '--get', key], { env, cwd });
    return stdout.trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return undefined;
    throw error;
  }
};

describe('GIT_ENV', () => {
  test('carries the variables of toolchain.md §4, plus GIT_OPTIONAL_LOCKS=0', () => {
    expect(GIT_ENV_VARS).toEqual({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    });
    expect(GIT_ENV).toMatchObject(GIT_ENV_VARS);
    expect(Object.isFrozen(GIT_ENV)).toBe(true);
    expect(Object.isFrozen(GIT_ENV_VARS)).toBe(true);
  });

  test('keeps PATH, so `git` is still found', () => {
    expect(GIT_ENV.PATH).toBe(process.env.PATH);
  });

  test('drops every inherited GIT_* variable: a test started from a git hook must not write into the real repository', () => {
    const env = gitEnv({
      base: {
        PATH: '/usr/bin',
        GIT_DIR: '/somewhere/.git',
        GIT_WORK_TREE: '/somewhere',
        GIT_INDEX_FILE: '/somewhere/.git/index',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 'leak',
        GIT_SSH_COMMAND: 'ssh -i key',
        EDITOR: 'vi',
      },
    });
    expect(env).toEqual({ PATH: '/usr/bin', EDITOR: 'vi', ...GIT_ENV_VARS });
  });

  test('a throwaway home redirects HOME and every XDG directory', () => {
    const env = gitEnv({
      home: '/tmp/h',
      base: { PATH: '/usr/bin', HOME: '/Users/me', XDG_CONFIG_HOME: '/Users/me/.config' },
    });
    expect(env).toMatchObject({
      HOME: '/tmp/h',
      XDG_CONFIG_HOME: '/tmp/h/.config',
      XDG_CACHE_HOME: '/tmp/h/.cache',
      XDG_DATA_HOME: '/tmp/h/.local/share',
      XDG_STATE_HOME: '/tmp/h/.local/state',
    });
  });

  test('extra variables win, and the result is a fresh object every time', () => {
    const env = gitEnv({ extra: { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', LC_ALL: 'C.UTF-8' } });
    expect(env.GIT_AUTHOR_DATE).toBe('2026-01-01T00:00:00Z');
    expect(env.LC_ALL).toBe('C.UTF-8');
    expect(gitEnv()).not.toBe(gitEnv());
    expect(gitEnv().GIT_AUTHOR_DATE).toBeUndefined();
  });

  test('global git config is not read: a canary planted in HOME and in XDG_CONFIG_HOME stays invisible', async ({
    tempDir,
  }) => {
    const home = join(tempDir, 'home');
    await mkdir(join(home, '.config', 'git'), { recursive: true });
    await writeFile(join(home, '.gitconfig'), '[canary]\n\thome = PLANTED-HOME\n[user]\n\tname = Canary\n');
    await writeFile(join(home, '.config', 'git', 'config'), '[canary]\n\txdg = PLANTED-XDG\n');

    // Control: without the hermetic variables git DOES read both files, so the canary is a real one.
    const leaky = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
    };
    expect(await configValue('canary.home', leaky, tempDir)).toBe('PLANTED-HOME');
    expect(await configValue('canary.xdg', leaky, tempDir)).toBe('PLANTED-XDG');

    const env = gitEnv({ home });
    expect(env.HOME).toBe(home);
    expect(await configValue('canary.home', env, tempDir)).toBeUndefined();
    expect(await configValue('canary.xdg', env, tempDir)).toBeUndefined();
    expect(await configValue('user.name', env, tempDir)).toBeUndefined();
  });

  test('system git config is not read: a canary planted as the system file stays invisible', async ({ tempDir }) => {
    const system = join(tempDir, 'etc-gitconfig');
    await writeFile(system, '[canary]\n\tsystem = PLANTED-SYSTEM\n');

    const leaky = {
      PATH: process.env.PATH ?? '',
      HOME: tempDir,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: system,
    };
    expect(await configValue('canary.system', leaky, tempDir)).toBe('PLANTED-SYSTEM');

    // Even a caller-supplied base that points at the planted file is neutralised.
    const env = gitEnv({ home: tempDir, base: { PATH: process.env.PATH ?? '', GIT_CONFIG_SYSTEM: system } });
    expect(await configValue('canary.system', env, tempDir)).toBeUndefined();
    const { stdout } = await run('git', ['config', '--list', '--show-origin'], { env, cwd: tempDir });
    expect(stdout).not.toContain('PLANTED');
  });
});
