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
    const completed: Array<{ domain: string; tasks: string[] }> = [];
    const outcomes: Array<{
      domain: string;
      spec?: string;
      tasks: string[];
      status: number;
      attempts: number;
      skipped?: boolean;
      reason?: string;
    }> = [];
    await mkdir(join(ctx.cwd, 'specs', 'reports'), { recursive: true });
    const runDomain = async (domain: string): Promise<number> => {
      const heading = headings.find((match) => match[1]?.trim() === domain);
      const start = heading?.index ?? -1;
      const next = start < 0 ? -1 : source.indexOf('\n## ', start + 1);
      const block = start < 0 ? '' : source.slice(start, next < 0 ? source.length : next);
      const tasks = block.split(/\r?\n/u).filter((line) => /^- \[ \]/u.test(line));
      if (!tasks.length) return 0;
      if (tasks.length < 5) {
        outcomes.push({
          domain,
          tasks,
          status: 0,
          attempts: 0,
          skipped: true,
          reason: 'small backlog: use the conversational refactor workflow',
        });
        return 0;
      }
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
      const first = await run.run(ctx, {
        ...args,
        positionals: [path, '--profile', 'feature', '--phases', 'BUILD,TEST,REVIEW', '--with-fix'],
      });
      const result =
        first === 3
          ? await run.run(ctx, {
              ...args,
              positionals: [path, '--profile', 'feature', '--phases', 'BUILD,TEST,REVIEW', '--with-fix'],
            })
          : first;
      outcomes.push({ domain, spec: path, tasks, status: result, attempts: first === 3 ? 2 : 1 });
      if (result === 0) {
        completed.push({ domain, tasks });
      }
      return result;
    };

    // V2 deliberately serialises the shared contract slice, then fans out
    // disjoint surfaces. Keeping that ordering avoids parallel agents editing
    // the same contract while retaining the wall-clock win for independent
    // domains.
    const ordered = domains.includes('shared')
      ? ['shared', ...domains.filter((domain) => domain !== 'shared')]
      : domains;
    const sharedStatus = ordered[0] === 'shared' ? await runDomain('shared') : 0;
    const parallelDomains = ordered[0] === 'shared' ? ordered.slice(1) : ordered;
    const statuses = sharedStatus === 0 ? await Promise.all(parallelDomains.map((domain) => runDomain(domain))) : [];
    for (const item of completed) {
      source = source
        .split(/\r?\n/u)
        .map((line) =>
          line.startsWith('- [ ] ') && item.tasks.includes(line) ? line.replace('- [ ] ', '- [x] ') : line,
        )
        .join('\n');
    }
    await writeFile(backlogPath, `${source}\n`, 'utf8');
    await writeFile(
      join(ctx.cwd, 'specs', 'reports', 'refactor.json'),
      `${JSON.stringify({ generatedAt: ctx.clock.now(), domains, outcomes }, null, 2)}\n`,
      'utf8',
    );
    return Math.max(sharedStatus, ...statuses, 0);
  },
};

export default refactor;
