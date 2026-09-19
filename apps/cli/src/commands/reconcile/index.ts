import { CohorteError, errorOf } from '@cohorte/base';
import { planReconcile, scanRepository } from '@cohorte/project-model';
import type { CommandModule } from '../../contract/index.ts';

const reconcile: CommandModule = {
  verb: 'reconcile',
  async run(ctx, args) {
    if (args.positionals.includes('--apply')) {
      throw new CohorteError(
        errorOf('configuration/phase-not-available', 'reconcile --apply is not available in V3.0'),
      );
    }
    if (!args.positionals.includes('--plan')) return 2;
    const plan = await planReconcile({
      root: ctx.cwd,
      scan: (root) => scanRepository(root, { clock: ctx.clock, toolVersion: '3.0.0' }),
      cohorteVersion: '3.0.0',
      clock: ctx.clock,
    });
    if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(plan)}\n`);
    else ctx.stdio.stdout.write(`${plan.operations.length} operation(s) planned\n`);
    return 0;
  },
};

export default reconcile;
