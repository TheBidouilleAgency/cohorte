// apps/cli/src/commands/spec/index.ts — DESIGN §9 verb `spec` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/spec/**`.
import { writeFile } from 'node:fs/promises';
import { freezeSpec, loadSpec } from '@cohorte/config';
import { stringify } from 'yaml';
import type { CommandModule } from '../../contract/index.ts';

const spec: CommandModule = {
  verb: 'spec',
  async run(ctx, args) {
    const file = args.positionals.find((value) => !value.startsWith('--'));
    if (!file) return 2;
    const frozen = args.subVerb === 'freeze';
    const value = frozen ? await freezeSpec(file) : await loadSpec(file);
    if (frozen) await writeFile(file, stringify(value));
    ctx.stdio.stdout.write(`${JSON.stringify(value)}\n`);
    return 0;
  },
};

export default spec;
