// apps/cli/src/commands/skip/index.ts — DESIGN §9 verb `skip` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/skip/**`.
import type { CommandModule } from '../../contract/index.ts';

const skip: CommandModule = {
  verb: 'skip',
  async run(ctx, args) {
    const [runId, phase, ...rest] = args.positionals;
    if (!runId || !phase) return 2;
    const result = await ctx.controller.send(
      'skip',
      { phase: phase as never, justification: rest.join(' ') || 'requested by operator' },
      { runId },
    );
    ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default skip;
