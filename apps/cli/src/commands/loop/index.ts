import type { CommandModule } from '../../contract/index.ts';
import run from '../run/index.ts';

const loop: CommandModule = {
  verb: 'loop',
  async run(ctx, args) {
    return run.run(ctx, { ...args, verb: 'run' });
  },
};

export default loop;
