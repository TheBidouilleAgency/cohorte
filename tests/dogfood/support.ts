import { execFile } from 'node:child_process';
import { cp, lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function copyWorkingTree(source: string, destination: string): Promise<void> {
  const listed = await exec('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: source });
  for (const entry of listed.stdout.split('\0').filter(Boolean)) {
    if (entry === '.cohorte' || entry.startsWith('.cohorte/') || entry.startsWith('node_modules/')) continue;
    const from = join(source, entry);
    const to = join(destination, entry);
    const stat = await lstat(from);
    if (stat.isDirectory()) await mkdir(to, { recursive: true });
    else {
      await mkdir(resolve(to, '..'), { recursive: true });
      await cp(from, to, { recursive: true, dereference: false, force: true });
    }
  }
}

export async function gitFixture(root: string): Promise<void> {
  await exec('git', ['init', '-q'], { cwd: root });
  await exec('git', ['config', 'user.email', 'cohorte-dogfood@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Cohorte dogfood'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-qm', 'working tree fixture'], { cwd: root });
}
