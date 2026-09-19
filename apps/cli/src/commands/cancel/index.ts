// apps/cli/src/commands/cancel/index.ts — DESIGN §9 verb `cancel` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/cancel/**`.
import type { CommandModule } from '../../contract/index.ts';

const cancel: CommandModule = {
  verb: 'cancel',
  async run(ctx, args) {
    const runId = args.positionals[0];
    if (!runId) return 2;
    const result = await ctx.controller.send('cancel', { keepWorktrees: false }, { runId });
    ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default cancel;
