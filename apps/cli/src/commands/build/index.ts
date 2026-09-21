import type { CommandModule } from '../../contract/index.ts';
import run from '../run/index.ts';

const build: CommandModule = {
  verb: 'build',
  async run(ctx, args) {
    return run.run(ctx, { ...args, positionals: [...args.positionals, '--phases', 'PREFLIGHT,BUILD,TEST'] });
  },
};

export default build;
