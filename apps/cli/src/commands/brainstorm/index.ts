import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CohorteError, errorOf } from '@cohorte/base';
import { stringify } from 'yaml';
import type { CommandModule } from '../../contract/index.ts';
import { configuredIdeas, moveConfiguredCard } from '../obsidian/index.ts';
import run from '../run/index.ts';

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'feature';
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function firstInput(args: readonly string[]): string | undefined {
  const valueFlags = new Set(['--id', '--output', '--ticket']);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value?.startsWith('--')) return value;
    if (valueFlags.has(value)) index++;
  }
  return undefined;
}

const brainstorm: CommandModule = {
  verb: 'brainstorm',
  async run(ctx, args) {
    let input = firstInput(args.positionals);
    let sourceId: string | undefined;
    if (!input) {
      const ideas = await configuredIdeas(ctx.env.HOME ?? ctx.cwd);
      const ticket = optionValue(args.positionals, '--ticket');
      const selected = ticket ? ideas.find((card) => card.id === ticket) : ideas.length === 1 ? ideas[0] : undefined;
      if (!selected) {
        if (!ideas.length) return 2;
        ctx.stdio.stdout.write(`${ideas.map((card) => `${card.id}\t${card.title}`).join('\n')}\n`);
        return 2;
      }
      input = selected.title;
      sourceId = selected.id;
    }

    const id = slugify(optionValue(args.positionals, '--id') ?? sourceId ?? input);
    const output = resolve(
      ctx.cwd,
      optionValue(args.positionals, '--output') ?? join('.cohorte', 'specs', `${id}.yaml`),
    );
    const spec = {
      id,
      kind: 'feature' as const,
      status: 'draft' as const,
      title: input,
      acceptance: [`Define the observable outcome for: ${input}`],
      surfaces: {},
      openQuestions: [
        'What user or operator problem does this solve?',
        'Which project surfaces are affected?',
        'What must be true for this feature to be accepted?',
      ],
    };

    try {
      await access(output);
      throw new CohorteError(errorOf('conflict/unexpected', `refusing to overwrite existing spec ${output}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, stringify(spec), 'utf8');
    if (sourceId) await moveConfiguredCard(ctx.env.HOME ?? ctx.cwd, sourceId, 'brainstorm', input);
    const result = { id, status: spec.status, path: output, next: `cohorte spec freeze ${output}` };
    ctx.stdio.stdout.write(`${args.json ? JSON.stringify(result) : `created ${output}\nnext: ${result.next}`}\n`);
    if (args.positionals.includes('--run')) {
      return run.run(ctx, {
        ...args,
        positionals: [
          id,
          output,
          '--phases',
          'BRAINSTORM,SPEC,PREFLIGHT,BUILD,TEST,REVIEW,FIX,TEST,REVIEW,SHIP',
          '--with-fix',
          '--runtime',
          optionValue(args.positionals, '--runtime') ?? 'pi',
        ],
      });
    }
    return 0;
  },
};

export default brainstorm;
