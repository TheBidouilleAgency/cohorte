import type { CommandModule } from '../../contract/index.ts';
import run from '../run/index.ts';

const loop: CommandModule = {
  verb: 'loop',
  async run(ctx, args) {
    const feature = args.positionals.find((value) => !value.startsWith('--'));
    if (!feature) return 2;
    return run.run(ctx, {
      ...args,
      positionals: [
        feature,
        '--profile',
        'feature',
        '--phases',
        'PREFLIGHT,BUILD,TEST,REVIEW,FIX,TEST,REVIEW,SHIP',
        '--with-fix',
        '--unattended',
        ...args.positionals.filter((value) => value.startsWith('--')),
      ],
    });
  },
};

export default loop;
