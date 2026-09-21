import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CohorteError, errorOf } from '@cohorte/base';
import { stringify } from 'yaml';
import type { CommandModule } from '../../contract/index.ts';

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

const brainstorm: CommandModule = {
  verb: 'brainstorm',
  async run(ctx, args) {
    const input = args.positionals.find((value) => !value.startsWith('--'));
    if (!input) return 2;

    const id = slugify(optionValue(args.positionals, '--id') ?? input);
    const output = optionValue(args.positionals, '--output') ?? join(ctx.cwd, '.cohorte', 'specs', `${id}.yaml`);
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
    const result = { id, status: spec.status, path: output, next: `cohorte spec freeze ${output}` };
    ctx.stdio.stdout.write(`${args.json ? JSON.stringify(result) : `created ${output}\nnext: ${result.next}`}\n`);
    return 0;
  },
};

export default brainstorm;
