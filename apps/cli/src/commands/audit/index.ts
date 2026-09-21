import type { CommandModule } from '../../contract/index.ts';
import review from '../review/index.ts';

const audit: CommandModule = {
  verb: 'audit',
  async run(ctx, args) {
    return review.run(ctx, args);
  },
};

export default audit;
