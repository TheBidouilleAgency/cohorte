// apps/cli/src/commands/logs/index.ts — DESIGN §9 verb `logs` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/logs/**`.
import type { CommandModule } from '../../contract/index.ts';
import { writeHuman } from '../../render/index.ts';

const logs: CommandModule = {
  verb: 'logs',
  async run(ctx, args) {
    const runId = args.positionals[0];
    if (!runId) return 2;
    const store = await ctx.openStore();
    const events = await store.readEvents(runId as never, { afterSequence: 0, limit: 1000 });
    try {
      for (const event of events) {
        if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(event)}\n`);
        else writeHuman(ctx, JSON.stringify(event));
      }
      return 0;
    } finally {
      await store.close();
    }
  },
};

export default logs;
