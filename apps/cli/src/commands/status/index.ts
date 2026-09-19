// apps/cli/src/commands/status/index.ts — DESIGN §9 verb `status` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/status/**`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CohorteError, errorOf } from '@cohorte/base';
import type { CommandModule } from '../../contract/index.ts';
import { writeHuman } from '../../render/index.ts';

const status: CommandModule = {
  verb: 'status',
  async run(ctx, args) {
    if (!existsSync(join(ctx.cwd, '.cohorte', 'project.yaml')))
      throw new CohorteError(errorOf('configuration/unexpected', `not a Cohorte project: ${ctx.cwd}`));
    const store = await ctx.openStore();
    const runId = args.positionals[0];
    const value = runId ? await store.getRun(runId as never) : await store.listRuns({ limit: 100, offset: 0 });
    try {
      if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(value)}\n`);
      else if (Array.isArray(value)) for (const run of value) writeHuman(ctx, `${run.runId} ${run.state}`);
      else writeHuman(ctx, value ? `${value.runId} ${value.state}` : 'run not found');
      return value === undefined ? 1 : 0;
    } finally {
      await store.close();
    }
  },
};

export default status;
