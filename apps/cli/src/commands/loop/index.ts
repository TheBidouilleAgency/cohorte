import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandModule } from '../../contract/index.ts';
import run from '../run/index.ts';

type LoopSnapshot = {
  id: string;
  round: number;
  maxRounds: number;
  phase: 'build' | 'review' | 'fix' | 'done';
  status: 'running' | 'pending' | 'completed' | 'rejected';
  runId?: string;
  outcome?: 'ship' | 'abort';
  reason?: string;
  startedAt: string;
  updatedAt: string;
};

function valueAfter(values: readonly string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  return index < 0 ? undefined : values[index + 1];
}

const loop: CommandModule = {
  verb: 'loop',
  async run(ctx, args) {
    const feature = args.positionals.find(
      (value, index) =>
        !value.startsWith('--') &&
        args.positionals[index - 1] !== '--max-rounds' &&
        args.positionals[index - 1] !== '--wait',
    );
    if (!feature) return 2;
    const parsedMax = Number(valueAfter(args.positionals, '--max-rounds') ?? 5);
    const maxRounds = Number.isInteger(parsedMax) ? Math.min(10, Math.max(1, parsedMax)) : 5;
    const reportPath = join(ctx.cwd, 'specs', 'reports', `${feature}.loop.json`);
    let previous: Partial<LoopSnapshot> | undefined;
    try {
      previous = JSON.parse(await readFile(reportPath, 'utf8')) as Partial<LoopSnapshot>;
    } catch {}
    const round = previous?.outcome ? 1 : Math.max(1, Number(previous?.round) || 1);
    const now = ctx.clock.now();
    const before: LoopSnapshot = {
      id: feature,
      round,
      maxRounds,
      phase: round === 1 ? 'build' : 'fix',
      status: 'running',
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
    };
    await mkdir(join(ctx.cwd, 'specs', 'reports'), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

    const result = await run.run(ctx, {
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
    const controllerResult = before;
    const output = {
      ...controllerResult,
      status: result === 4 ? 'pending' : result === 0 ? 'completed' : 'rejected',
      phase: result === 0 ? 'done' : controllerResult.phase,
      ...(result === 0
        ? { outcome: 'ship' as const }
        : result !== 4
          ? { outcome: 'abort' as const, reason: 'run-rejected' }
          : {}),
      updatedAt: ctx.clock.now(),
    } satisfies LoopSnapshot;
    await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    if (args.json) ctx.stdio.stdout.write(`${JSON.stringify({ ...output, reportPath })}\n`);
    else ctx.stdio.stdout.write(`loop ${output.status}: ${reportPath}\n`);
    return result;
  },
};

export default loop;
