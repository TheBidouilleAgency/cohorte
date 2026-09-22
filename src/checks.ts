import { randomUUID } from 'node:crypto';
import type { CheckResult, CheckRunner, Run } from './contracts.ts';
import { command } from './process.ts';

export class DockerChecks implements CheckRunner {
  async cleanup(run: Run) {
    const found = await command(run.config.docker, ['ps', '-aq', '--filter', `label=cohorte.run=${run.id}`]);
    if (found.exitCode !== 0) throw new Error('Cannot inspect remaining check containers');
    const ids = found.output.trim().split(/\s+/).filter(Boolean);
    if (!ids.every((id) => /^[a-f0-9]{12,64}$/.test(id))) throw new Error('Invalid container inventory');
    for (const id of ids) {
      const removed = await command(run.config.docker, ['rm', '-f', id]);
      if (removed.exitCode !== 0) throw new Error('Previous check container cleanup unconfirmed');
    }
  }
  async execute(run: Pick<Run, 'id' | 'worktree' | 'config'>, signal: AbortSignal): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    // Resolve once to immutable local image identity; execution never pulls implicitly.
    const image = await command(run.config.docker, ['image', 'inspect', '--format', '{{.Id}}', run.config.image]);
    const imageId = image.output.trim();
    if (image.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId))
      throw new Error('Check image absent. Pull the configured image explicitly before running.');
    for (const argv of run.config.checks) {
      signal.throwIfAborted();
      const name = `cohorte-${randomUUID()}`;
      const executable = argv[0];
      if (!executable) throw new Error('Empty check command');
      let failure: unknown;
      try {
        const result = await command(
          run.config.docker,
          [
            'create',
            '--name',
            name,
            '--label',
            `cohorte.run=${run.id}`,
            '--pull=never',
            '--network=none',
            '--read-only',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--pids-limit=128',
            '--memory=512m',
            '--cpus=1',
            '--user=65534:65534',
            '--tmpfs=/tmp:rw,nosuid,nodev,size=128m',
            '--env=HOME=/tmp',
            '--mount',
            `type=bind,source=${run.worktree},target=/workspace,readonly`,
            '--workdir=/workspace',
            '--entrypoint',
            executable,
            imageId,
            ...argv.slice(1),
          ],
          { timeoutMs: 15_000 },
        );
        if (result.exitCode !== 0) throw new Error('Cannot create isolated check container');
        signal.throwIfAborted();
        const checked = await command(run.config.docker, ['start', '--attach', name], {
          signal,
          timeoutMs: run.config.timeoutMs,
        });
        results.push({ argv, ...checked });
      } catch (error) {
        failure = error;
      }
      // Killing the docker client alone does not stop its container or descendants.
      const cleanup = await command(run.config.docker, ['rm', '-f', name], { timeoutMs: 15_000 });
      if (cleanup.exitCode !== 0 && !cleanup.output.includes('No such container'))
        throw new Error('Check container cleanup unconfirmed');
      if (failure) throw failure;
    }
    return results;
  }
}
