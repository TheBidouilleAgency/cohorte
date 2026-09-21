import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandModule } from '../../contract/index.ts';
import reconcile from '../reconcile/index.ts';

const updatePipeline: CommandModule = {
  verb: 'update-pipeline',
  async run(ctx, args) {
    const apply = args.positionals.includes('--apply');
    const plan = args.positionals.includes('--plan') || apply;
    if (!plan) return 2;
    let verification: { ok: boolean; detail?: string };
    try {
      const result = await ctx.assets.verify();
      verification = result.ok ? { ok: true } : { ok: false, detail: result.error.message };
    } catch (error) {
      verification = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    const manifest = await ctx.install.bundleManifest();
    const mode = apply ? '--apply' : '--plan';
    const result = await reconcile.run(ctx, { ...args, positionals: [...args.positionals, mode] });
    if (apply) {
      const report = {
        generatedAt: ctx.clock.now(),
        mode: 'apply',
        installDir: ctx.install.installDir(),
        bundleVerified: verification.ok,
        ...(verification.detail ? { verificationError: verification.detail } : {}),
        bundleFiles: manifest.length,
        reconcileStatus: result,
      };
      await mkdir(join(ctx.cwd, '.cohorte'), { recursive: true });
      await writeFile(
        join(ctx.cwd, '.cohorte', 'update-pipeline.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      );
      if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(report)}\n`);
      else
        ctx.stdio.stdout.write(
          `pipeline reconciled; bundle ${verification.ok ? 'verified' : 'verification failed'} (${manifest.length} files)\n`,
        );
    } else if (args.json) {
      ctx.stdio.stdout.write(
        `${JSON.stringify({ mode: 'plan', installDir: ctx.install.installDir(), bundleVerified: verification.ok, bundleFiles: manifest.length, reconcileStatus: result })}\n`,
      );
    }
    return result;
  },
};

export default updatePipeline;
