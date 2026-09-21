import type { CommandModule } from '../../contract/index.ts';
import reconcile from '../reconcile/index.ts';

const updatePipeline: CommandModule = {
  verb: 'update-pipeline',
  async run(ctx, args) {
    const mode = args.positionals.includes('--apply') ? '--apply' : '--plan';
    const result = await reconcile.run(ctx, { ...args, positionals: [...args.positionals, mode] });
    if (result === 0) ctx.stdio.stdout.write('pipeline assets reconciled; restart the CLI if the install changed\n');
    return result;
  },
};

export default updatePipeline;
