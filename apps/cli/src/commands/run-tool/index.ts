import type { CommandModule } from '../../contract/index.ts';

const runTool: CommandModule = {
  verb: 'run-tool',
  async run(ctx, args) {
    const [runId, tool, inputText, ...justificationParts] = args.positionals;
    if (!runId || !tool || !inputText || justificationParts.length === 0) return 2;
    let input: unknown;
    try {
      input = JSON.parse(inputText);
    } catch {
      return 2;
    }
    const result = await ctx.controller.send(
      'run-tool',
      { tool, input: input as never, justification: justificationParts.join(' ') },
      { runId },
    );
    if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    else ctx.stdio.stdout.write(`${result.status}\n`);
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default runTool;
