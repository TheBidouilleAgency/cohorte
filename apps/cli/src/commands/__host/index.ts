// apps/cli/src/commands/__host/index.ts — the hidden detached-host entry point (DESIGN 4.7).
import { CohorteError, errorOf } from '@cohorte/base';
import type { CommandModule } from '../../contract/index.ts';

const host: CommandModule = {
  verb: '__host',
  async run(ctx, args) {
    const runIndex = args.positionals.indexOf('--run');
    const runId = runIndex >= 0 ? args.positionals[runIndex + 1] : undefined;
    if (!runId || runId.startsWith('--')) return 2;
    if (!ctx.hostRunner) {
      throw new CohorteError(
        errorOf('configuration/unexpected', 'the detached host composition is missing its run engine binding'),
      );
    }
    const stop = await ctx.hostRunner.run(runId);
    ctx.stdio.stdout.write(`${JSON.stringify(stop)}\n`);
    return stop.reason === 'review-clean' ? 0 : 1;
  },
};

export default host;
