// apps/cli/src/commands/providers/index.ts — DESIGN §9 verb `providers` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/providers/**`.
import type { CommandModule } from '../../contract/index.ts';

const PROVIDERS = ['openai-codex', 'anthropic'] as const;

const providers: CommandModule = {
  verb: 'providers',
  async run(ctx, args) {
    if (args.subVerb !== 'list' && args.subVerb !== 'test' && args.subVerb !== undefined) return 10;
    const statuses = await ctx.runtime.resolve().authStatus([...PROVIDERS]);
    if (args.subVerb === 'test') {
      for (const status of statuses) ctx.stdio.stdout.write(`${status.provider}: ${status.state}\n`);
      return statuses.every((status) => status.state !== 'unknown-transient') ? 0 : 1;
    }
    for (const provider of PROVIDERS) ctx.stdio.stdout.write(`${provider}\n`);
    return 0;
  },
};

export default providers;
