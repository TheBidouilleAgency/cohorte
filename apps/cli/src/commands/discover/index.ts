import { CohorteError, errorOf } from '@cohorte/base';
import { scanRepository } from '@cohorte/project-model';
import type { CommandModule } from '../../contract/index.ts';

const discover: CommandModule = {
  verb: 'discover',
  async run(ctx, args) {
    if (args.positionals.includes('--semantic')) {
      throw new CohorteError(
        errorOf('configuration/phase-not-available', 'semantic discovery is not available in V3.0'),
      );
    }
    const model = await scanRepository(ctx.cwd, { clock: ctx.clock, toolVersion: '3.0.0' });
    if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(model)}\n`);
    else ctx.stdio.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
    return 0;
  },
};

export default discover;
