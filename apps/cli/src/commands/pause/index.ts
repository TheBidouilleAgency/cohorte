// apps/cli/src/commands/pause/index.ts — DESIGN §9 verb `pause` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/pause/**`.
import type { CommandModule } from '../../contract/index.ts';

const pause: CommandModule = {
  verb: 'pause',
  async run(ctx, args) {
    const runId = args.positionals[0];
    if (!runId) return 2;
    const reason = args.positionals.slice(1).join(' ');
    const result = await ctx.controller.send('pause', reason ? { reason } : {}, { runId });
    ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default pause;
