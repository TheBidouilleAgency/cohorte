// apps/cli/src/commands/init/index.ts — DESIGN §9 verb `init` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/init/**`.
import { resolve } from 'node:path';
import { applyInit, planInit, scanRepository } from '@cohorte/project-model';
import type { CommandModule } from '../../contract/index.ts';

const init: CommandModule = {
  verb: 'init',
  async run(ctx, args) {
    const requestedRoot = args.positionals.find((value) => !value.startsWith('--'));
    const root = requestedRoot === undefined ? ctx.cwd : resolve(ctx.cwd, requestedRoot);
    const model = await scanRepository(root, { clock: ctx.clock, toolVersion: '3.0.0' });
    const plan = await planInit({ root, model, cohorteVersion: '3.0.0' });
    if (args.positionals.includes('--plan') || args.json) {
      ctx.stdio.stdout.write(`${JSON.stringify(plan)}\n`);
      return 0;
    }
    const result = await applyInit(plan);
    ctx.stdio.stdout.write(`written: ${result.written.join(', ') || 'none'}\n`);
    return 0;
  },
};

export default init;
