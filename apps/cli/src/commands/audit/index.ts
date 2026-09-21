import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CommandModule } from '../../contract/index.ts';
import review from '../review/index.ts';

const exec = promisify(execFile);

const audit: CommandModule = {
  verb: 'audit',
  async run(ctx, args) {
    const target = args.positionals.find((value) => !value.startsWith('--'));
    if (target === undefined && args.positionals.length > 0) return 2;
    await mkdir(join(ctx.cwd, 'specs', 'reports'), { recursive: true });
    const gatePath = join(ctx.cwd, 'specs', 'reports', 'audit-gates.txt');
    let gate = '';
    try {
      const result = await exec('git', ['diff', '--check'], { cwd: ctx.cwd, maxBuffer: 1_000_000 });
      gate = result.stdout || 'git diff --check: clean\n';
    } catch (error) {
      gate = `${error instanceof Error ? error.message : String(error)}\n`;
    }
    await writeFile(gatePath, gate, 'utf8');
    const result = await review.run(ctx, {
      ...args,
      positionals: target ? [target, ...args.positionals.filter((x) => x.startsWith('--'))] : args.positionals,
    });
    ctx.stdio.stdout.write(`audit gates written to ${gatePath.replace(`${ctx.cwd}/`, '')}; review dispatched\n`);
    return result;
  },
};

export default audit;
