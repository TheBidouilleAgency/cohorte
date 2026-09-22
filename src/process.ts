import { spawn } from 'node:child_process';

/** Explicit environment: never pass API keys, subscription tokens or host config to checks. */
export function cleanEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' };
}
export async function command(
  binary: string,
  argv: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    limit?: number;
  } = {},
): Promise<{ exitCode: number; output: string }> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, {
      cwd: options.cwd,
      env: options.env ?? cleanEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let error: Error | undefined;
    const stop = () => {
      error ??= new Error('Command interrupted or timed out');
      child.kill('SIGKILL');
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.limit ?? 256 * 1024)) {
        error = new Error('Command output limit exceeded');
        stop();
      } else chunks.push(chunk);
    };
    child.stdout.on('data', data);
    child.stderr.on('data', data);
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', (e) => {
      error = e;
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', stop);
      if (error) reject(error);
      else resolve({ exitCode: code ?? -1, output: Buffer.concat(chunks).toString('utf8') });
    });
    if (signal.aborted) stop();
  });
}
export async function git(repo: string, args: string[]) {
  const result = await command('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    limit: 1024 * 1024,
  });
  if (result.exitCode !== 0) throw new Error(`Git failed: ${result.output.trim()}`);
  return result.output.trim();
}
