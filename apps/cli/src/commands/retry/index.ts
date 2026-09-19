// apps/cli/src/commands/retry/index.ts — DESIGN §9 verb `retry` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/retry/**`.
import type { CommandModule } from '../../contract/index.ts';

const retry: CommandModule = {
  verb: 'retry',
  async run(ctx, args) {
    const runId = args.positionals[0];
    if (!runId) return 2;
    const result = await ctx.controller.send('retry', { target: { kind: 'phase' } }, { runId });
    ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default retry;
