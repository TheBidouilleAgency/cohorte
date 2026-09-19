import { DEFAULT_CONFIG } from '@cohorte/config/schema';
import { applyReconcile, deriveDesiredState, planReconcile, scanRepository } from '@cohorte/project-model';
import type { CommandModule } from '../../contract/index.ts';

const reconcile: CommandModule = {
  verb: 'reconcile',
  async run(ctx, args) {
    const model = await scanRepository(ctx.cwd, { clock: ctx.clock, toolVersion: '3.0.0' });
    const plan = await planReconcile({
      root: ctx.cwd,
      scan: (root) => scanRepository(root, { clock: ctx.clock, toolVersion: '3.0.0' }),
      cohorteVersion: '3.0.0',
      clock: ctx.clock,
    });
    if (args.positionals.includes('--apply')) {
      const result = await applyReconcile({
        root: ctx.cwd,
        plan,
        desired: deriveDesiredState({ model, config: DEFAULT_CONFIG, cohorteVersion: '3.0.0', skills: {} }),
        backup: !args.positionals.includes('--no-backup'),
        clock: ctx.clock,
      });
      if (args.json) ctx.stdio.stdout.write(`${JSON.stringify({ plan, result })}\n`);
      else ctx.stdio.stdout.write(`applied: ${result.applied.join(', ') || 'none'}\n`);
      return 0;
    }
    if (!args.positionals.includes('--plan')) return 2;
    if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(plan)}\n`);
    else ctx.stdio.stdout.write(`${plan.operations.length} operation(s) planned\n`);
    return 0;
  },
};

export default reconcile;
