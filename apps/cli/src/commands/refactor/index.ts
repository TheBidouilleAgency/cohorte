import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { specContentSha256 } from '@cohorte/config/schema';
import { stringify } from 'yaml';
import type { CommandModule } from '../../contract/index.ts';
import run from '../run/index.ts';

const refactor: CommandModule = {
  verb: 'refactor',
  async run(ctx, args) {
    const backlogPath = join(ctx.cwd, 'specs', 'refactor-backlog.md');
    let source: string;
    try {
      source = await readFile(backlogPath, 'utf8');
    } catch {
      ctx.stdio.stderr.write(`backlog not found: ${backlogPath}\n`);
      return 1;
    }
    const requested = args.positionals.filter((value) => !value.startsWith('--'));
    const headings = [...source.matchAll(/^##\s+([^\n]+)$/gmu)];
    const domains =
      requested.includes('all') || requested.length === 0
        ? headings.map((match) => match[1]?.trim()).filter((x): x is string => Boolean(x))
        : requested;
    if (!domains.length) return 2;
    let status = 0;
    for (const domain of domains) {
      const heading = headings.find((match) => match[1]?.trim() === domain);
      const start = heading?.index ?? -1;
      const next = start < 0 ? -1 : source.indexOf('\n## ', start + 1);
      const block = start < 0 ? '' : source.slice(start, next < 0 ? source.length : next);
      const tasks = block.split(/\r?\n/u).filter((line) => /^- \[ \]/u.test(line));
      if (!tasks.length) continue;
      const id = `refactor-${domain
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-|-$/gu, '')}`;
      const draft = {
        id,
        kind: 'feature' as const,
        status: 'draft' as const,
        title: `Refactor ${domain}`,
        acceptance: tasks.map((task) => task.replace(/^- \[ \]\s*/u, '')),
        surfaces: { [domain]: { tasks } },
        openQuestions: [],
      };
      const spec = { ...draft, status: 'frozen' as const, sha256: specContentSha256(draft) };
      const path = join(ctx.cwd, '.cohorte', 'specs', `${id}.yaml`);
      await mkdir(join(ctx.cwd, '.cohorte', 'specs'), { recursive: true });
      await writeFile(path, stringify(spec), 'utf8');
      status = Math.max(
        status,
        await run.run(ctx, {
          ...args,
          positionals: [path, '--profile', 'feature', '--phases', 'BUILD,TEST,REVIEW', '--with-fix'],
        }),
      );
    }
    return status;
  },
};

export default refactor;
