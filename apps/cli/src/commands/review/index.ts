import type { CommandModule } from '../../contract/index.ts';
import { resolveSpecPath } from '../../project/spec-path.ts';

const review: CommandModule = {
  verb: 'review',
  async run(ctx, args) {
    const target = args.positionals.find((value) => !value.startsWith('--'));
    const result = await ctx.controller.send('start', {
      profile: 'review',
      unattended: false,
      ...(target?.startsWith('refs/') || target?.includes('..') || target?.includes('/')
        ? { reviewTarget: { ref: target } }
        : target
          ? { spec: { path: resolveSpecPath(ctx.cwd, target) }, reviewTarget: { ref: 'HEAD' } }
          : {}),
    });
    ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default review;
