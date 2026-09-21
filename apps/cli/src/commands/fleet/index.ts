import type { CommandModule } from '../../contract/index.ts';
import loop from '../loop/index.ts';

const fleet: CommandModule = {
  verb: 'fleet',
  async run(ctx, args) {
    const features = args.positionals.filter((value) => !value.startsWith('--'));
    if (features.length === 0) return 2;
    let status = 0;
    for (const feature of features) status = Math.max(status, await loop.run(ctx, { ...args, positionals: [feature] }));
    return status;
  },
};

export default fleet;
