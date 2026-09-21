// apps/cli/src/commands/fix/index.ts — DESIGN §9 verb `fix` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/fix/**`.
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CommandModule } from '../../contract/index.ts';
import { resolveSpecPath } from '../../project/spec-path.ts';
import { moveConfiguredCard } from '../obsidian/index.ts';

const fix: CommandModule = {
  verb: 'fix',
  async run(ctx, args) {
    const runId = args.positionals[0];
    if (!runId) return 2;
    const reportPath = args.positionals[1];
    if (reportPath && !runId.startsWith('run_')) {
      let specPath = resolveSpecPath(ctx.cwd, runId);
      try {
        await access(specPath);
      } catch {
        specPath = resolve(ctx.cwd, 'specs', `${runId}.md`);
      }
      let report: string;
      try {
        report = await readFile(reportPath, 'utf8');
      } catch {
        ctx.stdio.stderr.write(`review report not found: ${reportPath}\n`);
        return 1;
      }
      try {
        await access(specPath);
      } catch {
        ctx.stdio.stderr.write(`spec not found: ${specPath}\n`);
        return 1;
      }
      const source = await readFile(specPath, 'utf8');
      const heading = /\n## Remediation\n/u.test(source) ? '' : '\n\n## Remediation\n';
      const entry = `\n\n### ${ctx.clock.now()}\n\n${report.trim()}\n`;
      await writeFile(specPath, `${source.replace(/\s+$/u, '')}${heading}${entry}`, 'utf8');
      await moveConfiguredCard(ctx.env.HOME ?? ctx.cwd, runId, 'fix');
      ctx.stdio.stdout.write(
        `${JSON.stringify({ feature: runId, specPath, reportPath, status: 'remediation-recorded' })}\n`,
      );
      return 0;
    }
    const result = await ctx.controller.send('retry', { target: { kind: 'phase', state: 'FIX' } }, { runId });
    ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'pending' || result.status === 'completed')
      await moveConfiguredCard(ctx.env.HOME ?? ctx.cwd, runId, 'fix');
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default fix;
