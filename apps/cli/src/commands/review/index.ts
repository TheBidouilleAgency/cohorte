// apps/cli/src/commands/review/index.ts — DESIGN §9 verb `review` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/review/**`.
import type { CommandModule } from '../../contract/index.ts';

const review: CommandModule = {
  verb: 'review',
  async run(ctx, args) {
    const result = await ctx.controller.send('start', {
      profile: 'review',
      unattended: false,
      ...(args.positionals[0] ? { reviewTarget: { ref: args.positionals[0] } } : {}),
    });
    ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default review;
