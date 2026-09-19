import type { CommandModule } from '../../contract/index.ts';

const send: CommandModule = {
  verb: 'send',
  async run(ctx, args) {
    const [runId, agentId, ...textParts] = args.positionals;
    if (!runId || !agentId || textParts.length === 0) return 2;
    const result = await ctx.controller.send(
      'agent.send',
      { agentId: agentId as never, text: textParts.join(' '), delivery: 'steer' },
      { runId },
    );
    ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default send;
