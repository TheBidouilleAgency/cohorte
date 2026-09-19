// apps/cli/src/commands/models/index.ts — DESIGN §9 verb `models` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/models/**`.
import type { CommandModule } from '../../contract/index.ts';

const MODELS = [
  { provider: 'openai-codex', model: 'gpt-5.5', capabilities: ['coding', 'reasoning'] },
  { provider: 'openai-codex', model: 'gpt-5.4-mini', capabilities: ['fast', 'cheap'] },
] as const;

const models: CommandModule = {
  verb: 'models',
  async run(ctx, args) {
    if (args.subVerb !== 'list' && args.subVerb !== undefined) return 10;
    const value = { models: MODELS };
    if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(value)}\n`);
    else for (const model of MODELS) ctx.stdio.stdout.write(`${model.provider}/${model.model}\n`);
    return 0;
  },
};

export default models;
