// apps/cli/src/commands/migrate/index.ts — DESIGN §9 verb `migrate` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/migrate/**`.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { rollbackV2Import, type V2ImportReport } from '@cohorte/project-model';
import type { CommandModule } from '../../contract/index.ts';

const migrate: CommandModule = {
  verb: 'migrate',
  async run(ctx, args) {
    const rollback = args.positionals.indexOf('--rollback');
    if (rollback !== -1) {
      const reportId = args.positionals[rollback + 1];
      if (!reportId) throw new Error('configuration/import-invalid: migrate --rollback requires a report id');
      const reportPath = join(resolve(ctx.cwd), '.cohorte', 'import-reports', `${reportId}.json`);
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as V2ImportReport;
      const rolledBack = await rollbackV2Import(report);
      await writeFile(reportPath, `${JSON.stringify(rolledBack, null, 2)}\n`, { mode: 0o600 });
      ctx.stdio.stdout.write(`${JSON.stringify(rolledBack)}\n`);
      return 0;
    }
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
