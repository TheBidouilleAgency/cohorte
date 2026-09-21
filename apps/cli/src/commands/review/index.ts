import type { CommandModule } from '../../contract/index.ts';
import { resolveSpecPath } from '../../project/spec-path.ts';

const review: CommandModule = {
  verb: 'review',
  async run(ctx, args) {
    const valueAfter = (flag: string): string | undefined => {
      const index = args.positionals.indexOf(flag);
      return index >= 0 ? args.positionals[index + 1] : undefined;
    };
    const target = args.positionals.find(
      (value, index) =>
        !value.startsWith('--') &&
        args.positionals[index - 1] !== '--ref' &&
        args.positionals[index - 1] !== '--base' &&
        args.positionals[index - 1] !== '--head' &&
        args.positionals[index - 1] !== '--pr',
    );
    const ref = valueAfter('--ref');
    const base = valueAfter('--base');
    const head = valueAfter('--head');
    const pr = valueAfter('--pr');
    const surfaces = args.positionals
      .flatMap((value, index) =>
        value === '--surface' && args.positionals[index + 1] ? [args.positionals[index + 1] as never] : [],
      )
      .concat((valueAfter('--surfaces') ?? '').split(',').filter(Boolean) as never[]);
    if (args.positionals.includes('--pr') && !pr) return 2;
    const reviewTarget: { ref: string } | { base: string; head: string } | { runId: never } | undefined = pr
      ? { ref: `refs/pull/${pr}/head` }
      : base || head
        ? { base: base ?? 'HEAD~1', head: head ?? 'HEAD' }
        : ref
          ? { ref }
          : target?.startsWith('run_')
            ? { runId: target as never }
            : target?.includes('/') || target?.startsWith('refs/')
              ? { ref: target }
              : undefined;
    const result = await ctx.controller.send('start', {
      profile: 'review',
      unattended: false,
      ...(surfaces.length > 0 ? { surfaces } : {}),
      ...(reviewTarget ? { reviewTarget } : {}),
      ...(!reviewTarget && target ? { spec: { path: resolveSpecPath(ctx.cwd, target) } } : {}),
    });
    ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default review;
