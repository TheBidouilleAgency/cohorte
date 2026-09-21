import type { CommandModule } from '../../contract/index.ts';

const alignDs: CommandModule = {
  verb: 'align-ds',
  async run(ctx) {
    ctx.stdio.stdout.write('align-ds requires a project design-system adapter; no adapter is configured\n');
    return 0;
  },
};

export default alignDs;
