// apps/cli/src/panels/index.ts — AREA barrel: the `--panel` interactive views (francois.md), one function per
// panel kind, looked up by `render/index.ts`. Wave-0 stub: filled by `U4.04`, which owns `apps/cli/src/panels/**`.
import type { CliContext } from '../contract/index.ts';

export type Panel = (ctx: CliContext) => Promise<number>;

export const PANELS: Readonly<Record<string, Panel>> = Object.freeze({
  status: async (ctx) => {
    const store = await ctx.openStore();
    try {
      const runs = await store.listRuns({ limit: 20, offset: 0 });
      for (const run of runs) ctx.stdio.stdout.write(`${run.runId} ${run.state}\n`);
      return 0;
    } finally {
      await store.close();
    }
  },
});

export function resolvePanel(kind: string): Panel {
  const panel = PANELS[kind];
  if (!panel) throw new RangeError(`unknown panel kind: ${kind}`);
  return panel;
}
