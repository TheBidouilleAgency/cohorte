#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DockerChecks } from './checks.ts';
import { CodexRuntime } from './codex.ts';
import { parseConfig } from './contracts.ts';
import { git } from './process.ts';
import { prepareProfile } from './profile.ts';
import { createRun, lockRun, project } from './project.ts';
import { executeRun } from './workflow.ts';

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string', default: process.cwd() },
      config: { type: 'string' },
      spec: { type: 'string' },
      profile: { type: 'string' },
      out: { type: 'string' },
      'state-root': { type: 'string' },
      'acknowledge-uncertain': { type: 'boolean', default: false },
      codex: { type: 'string', default: 'codex' },
    },
  });
  const [verb, id] = positionals;
  if (!verb || verb === 'help') {
    console.log(`cohorte-next doctor [--codex /path/to/codex]
cohorte-next prepare --repo /repo --profile /profile.json --out /new-preparation-directory
cohorte-next check --repo /repo --config /preparation/config.json
cohorte-next run --repo /repo --config /config.json --spec /spec.md
cohorte-next status|logs|diff <run-id> --repo /repo
cohorte-next resume <run-id> --repo /repo --acknowledge-uncertain

Ctrl-C interrupts the active run. Inspect before explicitly restarting its phase.
Configuration and specs are frozen per run. No commits, pushes or API fallback.`);
    return;
  }
  if (verb === 'doctor') {
    console.log(JSON.stringify(await new CodexRuntime({ binary: values.codex }).doctor(), null, 2));
    return;
  }
  if (verb === 'prepare' || verb === 'check') {
    const stop = new AbortController();
    const interrupt = () => stop.abort();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      if (verb === 'prepare') {
        if (!values.profile || !values.out) throw new Error('--profile and --out required');
        console.log(
          JSON.stringify(await prepareProfile(values.repo, values.profile, values.out, stop.signal), null, 2),
        );
      } else {
        if (!values.config) throw new Error('--config required');
        const config = parseConfig(JSON.parse(await readFile(resolve(values.config), 'utf8')));
        const results = await new DockerChecks().execute(
          {
            id: randomUUID(),
            worktree: await realpath(values.repo),
            config,
          },
          stop.signal,
        );
        console.log(JSON.stringify(results, null, 2));
        process.exitCode = results.every((r) => r.exitCode === 0) ? 0 : 1;
      }
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
    return;
  }
  if (!['run', 'status', 'logs', 'diff', 'resume'].includes(verb)) throw new Error('Unknown command');
  if (verb === 'run') {
    if (!values.config || !values.spec) throw new Error('--config and --spec required');
    // Validate and check authentication before creating any branch/worktree.
    const config = parseConfig(JSON.parse(await readFile(resolve(values.config), 'utf8')));
    const auth = await new CodexRuntime({ binary: config.codex }).doctor();
    if (!auth.subscription) throw new Error('Run codex login with your ChatGPT account first');
  }
  const p = await project(resolve(values.repo), values['state-root'] ? resolve(values['state-root']) : undefined);
  try {
    let run =
      verb === 'run'
        ? await createRun(p.repo, p.state, values.config ?? '', values.spec ?? '', p.store)
        : p.store.get(id ?? '');
    if (verb === 'status') {
      console.log(JSON.stringify(run, null, 2));
      return;
    }
    if (verb === 'logs') {
      console.log(JSON.stringify(p.store.events(run.id), null, 2));
      return;
    }
    if (verb === 'diff') {
      console.log(await git(run.worktree, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD']));
      console.log('Untracked files:', await git(run.worktree, ['ls-files', '--others', '--exclude-standard']));
      return;
    }
    if (verb === 'resume' && !values['acknowledge-uncertain'])
      throw new Error('Inspect status/diff first; resume requires --acknowledge-uncertain');
    const unlock = await lockRun(p.state, run.id, values['acknowledge-uncertain']);
    const stop = new AbortController();
    const interrupt = () => stop.abort();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      if (verb === 'resume') p.store.event(run.id, 'run.retry-acknowledged', run.phase);
      // Manual inspection may include edits; a resumed review must get fresh checks.
      if (verb === 'resume' && run.phase === 'review') run.phase = 'test';
      const checks = new DockerChecks();
      if (verb === 'resume') await checks.cleanup(run);
      console.log(JSON.stringify({ runId: run.id, branch: run.branch, worktree: run.worktree }));
      run = await executeRun(run, p.store, new CodexRuntime({ binary: run.config.codex }), checks, stop.signal);
      console.log(
        JSON.stringify(
          { runId: run.id, status: run.status, phase: run.phase, round: run.round, summary: run.summary },
          null,
          2,
        ),
      );
      process.exitCode = run.status === 'completed' ? 0 : run.status === 'interrupted' ? 130 : 2;
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      await unlock();
    }
  } finally {
    p.store.close();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Cohorte failed');
  process.exitCode = 1;
});
