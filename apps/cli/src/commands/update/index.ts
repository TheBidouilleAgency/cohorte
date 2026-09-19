// apps/cli/src/commands/update/index.ts — DESIGN §9 verb `update` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/update/**`.
import type { CommandModule } from '../../contract/index.ts';

const update: CommandModule = {
  verb: 'update',
  async run(ctx, args) {
    if (!args.positionals.includes('--check')) return 10;
    ctx.stdio.stdout.write(`${JSON.stringify({ install: ctx.install.installDir(), updateAvailable: false })}\n`);
    return 0;
  },
};

export default update;
