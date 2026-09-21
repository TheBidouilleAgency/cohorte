import type { CommandModule } from '../../contract/index.ts';
import run from '../run/index.ts';

const refactor: CommandModule = {
  verb: 'refactor',
  async run(ctx, args) {
    return run.run(ctx, { ...args, positionals: [...args.positionals, '--profile', 'feature'] });
  },
};

export default refactor;
