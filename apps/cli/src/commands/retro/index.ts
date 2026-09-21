import type { CommandModule } from '../../contract/index.ts';

const retro: CommandModule = {
  verb: 'retro',
  async run(ctx) {
    ctx.stdio.stdout.write(
      'retro is read-only in V3: inspect completed review reports and promote conventions manually\n',
    );
    return 0;
  },
};

export default retro;
