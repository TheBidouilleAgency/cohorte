// apps/cli/src/commands/inspect/index.ts — DESIGN §9 verb `inspect` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/inspect/**`.
import type { CommandModule } from '../../contract/index.ts';
import { writeHuman } from '../../render/index.ts';

const inspect: CommandModule = {
  verb: 'inspect',
  async run(ctx, args) {
    const runId = args.positionals[0];
    if (!runId) return 2;
    const store = await ctx.openStore();
    const value = await store.readRunTree(runId as never);
    try {
      if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(value)}\n`);
      else writeHuman(ctx, JSON.stringify(value, null, 2));
      return 0;
    } finally {
      await store.close();
    }
  },
};

export default inspect;
