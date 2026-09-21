import type { CommandModule } from '../../contract/index.ts';
import update from '../update/index.ts';

const updatePipeline: CommandModule = {
  verb: 'update-pipeline',
  async run(ctx, args) {
    return update.run(ctx, args);
  },
};

export default updatePipeline;
