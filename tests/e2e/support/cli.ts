import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunStatus {
  readonly runId: string;
  readonly state: string;
  readonly snapshotDigest?: string;
  readonly runtimePin?: { readonly digest?: string };
  readonly zones?: readonly string[];
}

export async function createGitFixture(): Promise<{ root: string; home: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'cohorte-e2e-'));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'cohorte-e2e@example.test']);
  await runGit(root, ['config', 'user.name', 'Cohorte E2E']);
  await writeFile(join(root, '.keep'), 'fixture\n');
  await runGit(root, ['add', '.keep']);
  await runGit(root, ['commit', '-qm', 'fixture']);
  return { root, home, dispose: () => rm(root, { recursive: true, force: true }) };
}

export function cliPath(): string {
  const build = process.env.COHORTE_E2E_BUILD_DIR;
  if (!build) throw new Error('COHORTE_E2E_BUILD_DIR is required for built E2E tests');
  return join(isAbsolute(build) ? build : resolve(process.cwd(), build), '.publish', 'dist', 'cli.mjs');
}

export async function runCli(root: string, home: string, args: readonly string[]): Promise<CliResult> {
  return runCliEntry(root, home, cliPath(), args);
}

export async function runCliWithEnv(
  root: string,
  home: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string | undefined>>,
): Promise<CliResult> {
  return runCliEntry(root, home, cliPath(), args, extraEnv);
}

export async function runCliAt(
  installDir: string,
  root: string,
  home: string,
  args: readonly string[],
): Promise<CliResult> {
  return runCliEntry(root, home, join(installDir, 'dist', 'cli.mjs'), args);
}

export async function runCliAtWithEnv(
  installDir: string,
  root: string,
  home: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string | undefined>>,
): Promise<CliResult> {
  return runCliEntry(root, home, join(installDir, 'dist', 'cli.mjs'), args, extraEnv);
}

async function runCliEntry(
  root: string,
  home: string,
  entry: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string | undefined>> = {},
): Promise<CliResult> {
  try {
    const result = await exec(process.execPath, [entry, ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...extraEnv },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

export async function initAndTrust(root: string, home: string): Promise<void> {
  const init = await runCli(root, home, ['init', '--json', root]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr || init.stdout}`);
  const trust = await runCli(root, home, ['config', 'trust', '--grant']);
  if (trust.code !== 0) throw new Error(`trust failed: ${trust.stderr || trust.stdout}`);
}

export async function waitForRun(root: string, home: string, timeoutMs = 15_000): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  let latest: RunStatus | undefined;
  while (Date.now() < deadline) {
    const result = await runCli(root, home, ['status', '--json']);
    if (result.code === 0 && result.stdout.trim()) {
      const rows = JSON.parse(result.stdout) as RunStatus[];
      latest = rows[0];
      if (
        latest &&
        [
          'COMPLETED',
          'FAILED',
          'BLOCKED',
          'CANCELLED',
          'PAUSED',
          'WAITING_APPROVAL',
          'AUTH_REQUIRED',
          'QUOTA_EXCEEDED',
        ].includes(latest.state)
      )
        return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`run did not reach a terminal state: ${JSON.stringify(latest)}`);
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await exec('git', args, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
}

export async function writeHappyFakeScript(root: string): Promise<string> {
  const path = join(root, 'fake-script.yaml');
  await writeFile(
    path,
    'version: 1\nagents:\n  - match: {}\n    steps:\n      - do: submit\n        output: { status: clean }\n',
  );
  return path;
}

export async function commitFixture(root: string, message: string, paths = ['fake-script.yaml']): Promise<void> {
  await runGit(root, ['add', ...paths]);
  await runGit(root, ['commit', '-qm', message]);
}
