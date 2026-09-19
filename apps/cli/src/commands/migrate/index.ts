// apps/cli/src/commands/migrate/index.ts — DESIGN §9 verb `migrate` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/migrate/**`.
import type { CommandModule } from '../../contract/index.ts';

const migrate: CommandModule = {
  verb: 'migrate',
  async run(ctx, args) {
    const store = await (ctx.openMigrationStore ?? ctx.openStore)();
    try {
      const apply = args.positionals.includes('--apply');
      const report = await store.migrate(apply ? 'apply' : 'check');
      ctx.stdio.stdout.write(`${JSON.stringify(report)}\n`);
      return !apply && report.pending.length > 0 ? 3 : 0;
    } finally {
      await store.close();
    }
  },
};

export default migrate;
