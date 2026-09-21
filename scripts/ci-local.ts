#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

type Job = { name: string; command: string[] };

const jobs: readonly Job[] = [
  { name: 'lint', command: ['pnpm', 'ci:lint'] },
  { name: 'typecheck', command: ['pnpm', 'ci:typecheck'] },
  { name: 'unit', command: ['pnpm', 'ci:unit'] },
  { name: 'integration', command: ['pnpm', 'ci:integration'] },
  { name: 'schema-compat', command: ['pnpm', 'ci:schema-compat'] },
  { name: 'migrations', command: ['pnpm', 'ci:migrations'] },
  { name: 'packaging', command: ['pnpm', 'ci:packaging'] },
  { name: 'e2e-fake', command: ['pnpm', 'ci:e2e-fake'] },
  { name: 'crash-matrix', command: ['pnpm', 'ci:crash-matrix'] },
  { name: 'security', command: ['pnpm', 'ci:security'] },
  { name: 'dogfood', command: ['pnpm', 'ci:dogfood'] },
  { name: 'acceptance', command: ['pnpm', 'ci:acceptance'] },
  { name: 'pi-latest', command: ['pnpm', 'ci:pi-latest'] },
];

const selected = process.argv.slice(2);
const selectedJobs = selected.length === 0 ? jobs : jobs.filter((job) => selected.includes(job.name));
if (selected.length > 0 && selectedJobs.length !== selected.length) {
  const known = jobs.map((job) => job.name).join(', ');
  process.stderr.write(`ci:local: unknown job (known: ${known})\n`);
  process.exitCode = 2;
} else {
  for (const job of selectedJobs) {
    process.stdout.write(`ci:local: ${job.name}\n`);
    const [command, ...args] = job.command;
    if (command === undefined) throw new Error(`ci:local: empty command for ${job.name}`);
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
