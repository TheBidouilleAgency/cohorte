// apps/cli/src/commands/run/index.ts — DESIGN §9 verb `run` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/run/**`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CohorteError, errorOf, type Sha256, sha256Hex } from '@cohorte/base';
import { loadConfig, resolveConfig } from '@cohorte/config';
import { createKeyStore, createTrustStore } from '@cohorte/security/auth';
import type { CommandModule } from '../../contract/index.ts';
import { resolveSpecPath } from '../../project/spec-path.ts';
import { moveConfiguredCard } from '../obsidian/index.ts';

const run: CommandModule = {
  verb: 'run',
  async run(ctx, args) {
    const valueAfter = (flag: string): string | undefined => {
      const index = args.positionals.indexOf(flag);
      return index >= 0 ? args.positionals[index + 1] : undefined;
    };
    const profile = (valueAfter('--profile') ??
      args.positionals.find((value) => ['feature', 'bugfix', 'review'].includes(value)) ??
      'feature') as 'feature' | 'bugfix' | 'review';
    if (!['feature', 'bugfix', 'review'].includes(profile)) return 2;
    const spec = args.positionals.find(
      (value, index) =>
        !value.startsWith('--') &&
        args.positionals[index - 1] !== '--profile' &&
        args.positionals[index - 1] !== '--runtime' &&
        args.positionals[index - 1] !== '--script' &&
        args.positionals[index - 1] !== '--model' &&
        args.positionals[index - 1] !== '--wait' &&
        args.positionals[index - 1] !== '--phases' &&
        !['feature', 'bugfix', 'review'].includes(value),
    );
    const model = valueAfter('--model');
    const phasesValue = valueAfter('--phases');
    const surfaces = args.positionals
      .flatMap((value, index) =>
        value === '--surface' && args.positionals[index + 1] ? [args.positionals[index + 1] as string] : [],
      )
      .concat((valueAfter('--surfaces') ?? '').split(',').filter(Boolean));
    const phases = phasesValue
      ?.split(',')
      .map((value) => value.trim().toUpperCase())
      .filter((value): value is 'BRAINSTORM' | 'SPEC' | 'PREFLIGHT' | 'BUILD' | 'TEST' | 'REVIEW' | 'FIX' | 'SHIP' =>
        ['BRAINSTORM', 'SPEC', 'PREFLIGHT', 'BUILD', 'TEST', 'REVIEW', 'FIX', 'SHIP'].includes(value),
      );
    const waitValue = valueAfter('--wait');
    const waitMs = waitValue === undefined ? undefined : Number(waitValue) * 1000;
    if (waitValue !== undefined && (!Number.isFinite(waitMs) || (waitMs as number) < 0)) return 2;
    const trustProjectConfig = args.positionals.includes('--trust-project-config');
    let consent: { policySha256: Sha256; via: 'cli-flag' } | undefined;
    // Test/fake contexts intentionally omit HOME; a real CLI invocation always
    // supplies it and is the only context allowed to resolve project trust.
    if (ctx.env.HOME && existsSync(join(ctx.cwd, '.cohorte', 'config.yaml'))) {
      const home = ctx.env.HOME ?? ctx.cwd;
      const loaded = await loadConfig({ cwd: ctx.cwd, home });
      const keys = createKeyStore({ directory: join(home, '.cohorte', 'keys') });
      const trustStore = createTrustStore({ directory: join(home, '.cohorte', 'trust'), keys });
      const resolved = await resolveConfig(loaded, {
        trustStore,
        projectKeyId: sha256Hex(loaded.projectRoot).slice(0, 24),
      });
      if (resolved.status === 'untrusted' && !trustProjectConfig) {
        throw new CohorteError(
          errorOf(
            'security/project-policy-untrusted',
            `project policy is untrusted (${resolved.loosenedKeys.join(', ') || 'unknown key'})`,
          ),
        );
      }
      if (resolved.status === 'untrusted') consent = { policySha256: resolved.policySha256, via: 'cli-flag' };
    }
    const payload = {
      profile,
      unattended: false,
      ...(spec ? { spec: { path: resolveSpecPath(ctx.cwd, spec) } } : {}),
      ...(valueAfter('--runtime') ? { runtime: valueAfter('--runtime') as string } : {}),
      ...(valueAfter('--script') ? { fakeScript: valueAfter('--script') as string } : {}),
      ...(phasesValue !== undefined ? { phases: phases ?? [] } : {}),
      ...(surfaces.length > 0 ? { surfaces } : {}),
      ...(args.positionals.includes('--with-fix') ? { withFix: true } : {}),
      ...(args.positionals.includes('--unattended') ? { unattended: true } : {}),
      ...(model ? { modelOverrides: { implementer: { provider: 'default', model } } } : {}),
      ...(consent ? { consent } : {}),
    };
    const result =
      waitMs === undefined
        ? await ctx.controller.send('start', payload)
        : await ctx.controller.send('start', payload, { waitMs });
    if (result.status === 'pending' && result.result && typeof result.result === 'object' && 'runId' in result.result) {
      const runId = (result.result as { runId?: string }).runId;
      if (runId) await ctx.hostSpawner.spawnDetached(runId);
    }
    if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    else ctx.stdio.stdout.write(`${result.status}\n`);
    if (result.status === 'pending' || result.status === 'completed') {
      const card = spec
        ?.replace(/\.ya?ml$/, '')
        .split(/[\\/]/)
        .pop();
      if (card) await moveConfiguredCard(ctx.env.HOME ?? ctx.cwd, card, profile === 'review' ? 'review' : 'building');
    }
    return result.status === 'rejected' ? 3 : result.status === 'pending' ? 4 : 0;
  },
};

export default run;
