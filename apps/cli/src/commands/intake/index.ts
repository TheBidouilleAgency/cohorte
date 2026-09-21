import type { CommandModule } from '../../contract/index.ts';
import brainstorm from '../brainstorm/index.ts';

const intake: CommandModule = {
  verb: 'intake',
  async run(ctx, args) {
    return brainstorm.run(ctx, args);
  },
};

export default intake;
