// apps/cli/src/commands/ship/index.ts — DESIGN §9 verb `ship` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/ship/**`.
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CommandModule } from '../../contract/index.ts';

const exec = promisify(execFile);

const ship: CommandModule = {
  verb: 'ship',
  async run(ctx, args) {
    const [runId, approvalId] = args.positionals;
    if (!runId) return 2;
    if (!runId.startsWith('run_') && !approvalId) {
      const specPath = resolve(ctx.cwd, 'specs', `${runId}.md`);
      let spec = '';
      try {
        spec = await readFile(specPath, 'utf8');
      } catch {
        ctx.stdio.stderr.write(`frozen spec not found: ${specPath}\n`);
        return 1;
      }
      if (!/^status:\s*frozen\s*$/mu.test(spec.slice(0, 1500))) {
        ctx.stdio.stderr.write('ship requires a frozen spec\n');
        return 11;
      }
      const reports = join(ctx.cwd, 'specs', 'reports');
      let verdict = false;
      try {
        for (const name of await readdir(reports)) {
          if (!name.includes(runId)) continue;
          const text = await readFile(join(reports, name), 'utf8');
          if (/\bSHIP\b/u.test(text)) verdict = true;
        }
      } catch {}
      if (!verdict) {
        ctx.stdio.stderr.write('ship requires a durable SHIP review verdict\n');
        return 11;
      }
      const { stdout: branch } = await exec('git', ['branch', '--show-current'], { cwd: ctx.cwd });
      const { stdout: status } = await exec('git', ['status', '--porcelain'], { cwd: ctx.cwd });
      const { stdout: stat } = await exec('git', ['diff', '--stat'], { cwd: ctx.cwd });
      const reportPath = join(reports, `${runId}-release.md`);
      await mkdir(reports, { recursive: true });
      await writeFile(
        reportPath,
        `# Release — ${runId}\n\n- generated: ${ctx.clock.now()}\n- branch: ${branch.trim()}\n- clean: ${status.trim() === ''}\n\n## Diff\n\n${stat.trim() || '(empty)'}\n\n## Handoff\n\nReview the branch and run the repository release procedure.\n`,
        'utf8',
      );
      ctx.stdio.stdout.write(
        `${JSON.stringify({ feature: runId, reportPath, branch: branch.trim(), clean: status.trim() === '' })}\n`,
      );
      return status.trim() === '' ? 0 : 11;
    }
    if (!approvalId) return 2;
    const result = await ctx.controller.send(
      'approve',
      { approvalId: approvalId as never, scope: 'run', answer: 'ship' },
      { runId },
    );
    ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default ship;
