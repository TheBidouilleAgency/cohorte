// apps/cli/src/commands/init/index.ts — DESIGN §9 verb `init` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/init/**`.
import { resolve } from 'node:path';
import { applyInit, applyV2Import, exportV2, planInit, planV2Import, scanRepository } from '@cohorte/project-model';
import type { CommandModule } from '../../contract/index.ts';

const init: CommandModule = {
  verb: 'init',
  async run(ctx, args) {
    const fromV2 = args.positionals.indexOf('--from-v2');
    const exportV2At = args.positionals.indexOf('--export-v2');
    const optionValues = new Set(
      [fromV2, exportV2At]
        .filter((index) => index !== -1)
        .map((index) => args.positionals[index + 1])
        .filter((value): value is string => value !== undefined),
    );
    const requestedRoot = args.positionals.find((value) => !value.startsWith('--') && !optionValues.has(value));
    const root = requestedRoot === undefined ? ctx.cwd : resolve(ctx.cwd, requestedRoot);
    if (fromV2 !== -1) {
      const bundle = args.positionals[fromV2 + 1];
      if (!bundle) throw new Error('configuration/import-invalid: init --from-v2 requires a bundle directory');
      const model = await scanRepository(root, { clock: ctx.clock, toolVersion: '3.0.0-v2-import' });
      const plan = await planV2Import(resolve(ctx.cwd, bundle), root, { model });
      if (!args.positionals.includes('--yes') && !args.json) {
        ctx.stdio.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        return plan.conflicts.length ? 3 : 0;
      }
      const result = await applyV2Import(plan, {
        confirm: args.positionals.includes('--yes'),
        backupRoot: resolve(root, '..', '.cohorte-migration-backups'),
      });
      ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (exportV2At !== -1) {
      const destination = args.positionals[exportV2At + 1];
      if (!destination) throw new Error('configuration/import-invalid: init --export-v2 requires a destination');
      const result = await exportV2({ root, destination: resolve(ctx.cwd, destination) });
      ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
      return result.manifest.warnings.some((item) => item.blocking) ? 3 : 0;
    }
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
