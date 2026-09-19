// apps/cli/src/commands/doctor/index.ts — DESIGN §9 verb `doctor` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/doctor/**`.
import { probeSandbox } from '@cohorte/security/exec';
import type { CommandModule } from '../../contract/index.ts';
import { runDoctor } from '../../doctor/index.ts';

const doctor: CommandModule = {
  verb: 'doctor',
  async run(ctx, args) {
    const checks = await runDoctor(ctx, { verifyState: args.positionals.includes('--verify-state') });
    if (args.json) {
      let sandbox: unknown = {};
      let runtimeCapabilities: unknown = {};
      try {
        sandbox = await probeSandbox();
      } catch {
        // The corresponding check already reports the diagnostic; keep JSON stable.
      }
      try {
        runtimeCapabilities = ctx.runtime.capabilities?.() ?? { provider: ctx.runtime.resolve().id };
      } catch {
        // A provider may be unavailable while the rest of doctor remains useful.
      }
      ctx.stdio.stdout.write(
        `${JSON.stringify({ documentVersion: 1, cohorteVersion: '3.0.0', generatedAt: ctx.clock.now(), ok: checks.every((check) => check.status === 'ok' || check.status === 'skipped'), checks, sandbox, runtimeCapabilities })}\n`,
      );
    } else
      for (const check of checks) ctx.stdio.stdout.write(`${check.status.padEnd(7)} ${check.id}: ${check.summary}\n`);
    return checks.some((check) => check.status === 'error') ? 1 : 0;
  },
};

export default doctor;
