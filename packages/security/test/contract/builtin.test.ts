import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  AGENT_GIT_DENIED_SUBCOMMANDS,
  DEFAULT_DENY_GLOBS,
  isTrampoline,
  L0_ENV_ALLOWLIST,
  L0_ENV_FIXED,
  L1_DENY_READ_HOME_PATHS,
  OS_INJECTED_ENV,
  PROTECTED_HOME_PATHS,
  PROTECTED_REPO_GLOBS,
  TRAMPOLINE_PROGRAMS,
  visibleEnvAllowed,
} from '../../src/contract/index.ts';

const PACKAGES = join(import.meta.dirname, '../../..');

describe('built-in, non-overridable data', () => {
  test('the trampoline set', () => {
    for (const name of [
      'sh',
      'bash',
      'zsh',
      'env',
      'xargs',
      'sudo',
      'npx',
      'pnpx',
      'bunx',
      'corepack',
      'ssh',
      'curl',
    ]) {
      expect(TRAMPOLINE_PROGRAMS, name).toContain(name);
    }
    expect(TRAMPOLINE_PROGRAMS, 'Pi can print the OAuth token').toContain('pi');
    expect(TRAMPOLINE_PROGRAMS).toContain('cohorte');
    expect(TRAMPOLINE_PROGRAMS).toContain('osascript');
    expect(TRAMPOLINE_PROGRAMS).toHaveLength(new Set(TRAMPOLINE_PROGRAMS).size);
  });

  test.for(['bash', 'python', 'python3', 'python3.12', 'perl', 'ruby', 'pi', 'cohorte', 'nc', 'wget'])(
    '%s is a trampoline',
    (name) => {
      expect(isTrampoline(name)).toBe(true);
    },
  );

  test.for(['git', 'pnpm', 'npm', 'yarn', 'node', 'docker', 'tsc', 'pip', 'Bash'])('%s is not', (name) => {
    expect(isTrampoline(name)).toBe(false);
  });

  test('the agent git deny set (D9)', () => {
    for (const subcommand of [
      'commit',
      'push',
      'merge',
      'rebase',
      'reset',
      'checkout',
      'switch',
      'worktree',
      'config',
      'update-ref',
      'filter-branch',
      'gc',
    ]) {
      expect(AGENT_GIT_DENIED_SUBCOMMANDS, subcommand).toContain(subcommand);
    }
    for (const harmless of ['status', 'diff', 'log', 'show']) {
      expect(AGENT_GIT_DENIED_SUBCOMMANDS).not.toContain(harmless);
    }
  });

  test('protected roots: .git, .cohorte/** and .pi/** at any depth', () => {
    expect([...PROTECTED_REPO_GLOBS]).toEqual(['**/.git', '**/.git/**', '**/.cohorte/**', '**/.pi/**']);
    for (const glob of PROTECTED_REPO_GLOBS) expect(DEFAULT_DENY_GLOBS).toContain(glob);
    expect(DEFAULT_DENY_GLOBS).toContain('**/.env*');
    expect(DEFAULT_DENY_GLOBS).toContain('**/.npmrc');
  });

  test('protected home paths: keys, versions, pi-agent, brains, trust, the user config — and NOT the worktree root', () => {
    for (const path of ['keys', 'versions', 'pi-agent', 'brains', 'trust']) {
      expect(PROTECTED_HOME_PATHS).toContain(`.cohorte/${path}`);
      expect(L1_DENY_READ_HOME_PATHS).toContain(`.cohorte/${path}`);
    }
    expect(PROTECTED_HOME_PATHS).toContain('.cohorte/config.yaml');
    for (const path of ['.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.pi/agent']) {
      expect(PROTECTED_HOME_PATHS).toContain(path);
      expect(L1_DENY_READ_HOME_PATHS).toContain(path);
    }
    const all: string[] = [...PROTECTED_HOME_PATHS, ...L1_DENY_READ_HOME_PATHS];
    expect(all.filter((path) => path === '.cohorte' || path.startsWith('.cohorte/worktrees'))).toEqual([]);
  });

  test('the L0 env allowlist: eleven names, no credential, fixed values for the constant ones', () => {
    expect([...L0_ENV_ALLOWLIST].sort()).toEqual(
      [
        'CI',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_TERMINAL_PROMPT',
        'HOME',
        'LANG',
        'LC_ALL',
        'NO_COLOR',
        'PATH',
        'TERM',
        'TMPDIR',
      ].sort(),
    );
    expect(L0_ENV_ALLOWLIST.filter((name) => /KEY|TOKEN|SECRET|AWS|GOOGLE|GH_/.test(name))).toEqual([]);
    expect(L0_ENV_FIXED).toMatchObject({
      TERM: 'dumb',
      CI: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    });
    for (const name of Object.keys(L0_ENV_FIXED)) expect(L0_ENV_ALLOWLIST).toContain(name);
  });

  test('everything is frozen', () => {
    for (const data of [
      PROTECTED_REPO_GLOBS,
      PROTECTED_HOME_PATHS,
      L1_DENY_READ_HOME_PATHS,
      DEFAULT_DENY_GLOBS,
      TRAMPOLINE_PROGRAMS,
      AGENT_GIT_DENIED_SUBCOMMANDS,
      L0_ENV_ALLOWLIST,
      L0_ENV_FIXED,
      OS_INJECTED_ENV,
      OS_INJECTED_ENV.darwin,
    ]) {
      expect(Object.isFrozen(data)).toBe(true);
    }
  });
});

describe('OS_INJECTED_ENV (PLAN F-8)', () => {
  test('darwin: CoreFoundation injects __CF_USER_TEXT_ENCODING into every process', () => {
    expect(OS_INJECTED_ENV).toEqual({ darwin: ['__CF_USER_TEXT_ENCODING'] });
    expect([...visibleEnvAllowed(['PATH'], 'darwin')].sort()).toEqual(['PATH', '__CF_USER_TEXT_ENCODING']);
    expect([...visibleEnvAllowed(['PATH'], 'linux')]).toEqual(['PATH']);
  });

  test('equals the mirror exported by @cohorte/runtime-pi/host-protocol', async () => {
    // By FILE, not by package name: `security -> runtime-pi` is not an edge of layers.json, not even a dev one.
    const file = pathToFileURL(join(PACKAGES, 'runtime-pi/src/protocol.ts')).href;
    const mirror = (await import(file)) as { OS_INJECTED_ENV: unknown };
    expect(mirror.OS_INJECTED_ENV).toEqual(OS_INJECTED_ENV);
  });
});

describe('@cohorte/security names no protocol type (DESIGN 1.2)', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
    );

  test('no file under packages/security/src imports @cohorte/protocol', () => {
    const files = sources(join(PACKAGES, 'security/src'));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((file) => /from\s+['"]@cohorte\/protocol/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('and the package does not declare it', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGES, 'security/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies)).not.toContain('@cohorte/protocol');
  });
});
