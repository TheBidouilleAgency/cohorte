// apps/cli/src/commands/config/index.ts — DESIGN §9 verb `config` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/config/**`.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '@cohorte/base';
import { loadConfig, resolveConfig } from '@cohorte/config';
import { createKeyStore, createTrustStore } from '@cohorte/security/auth';
import { parse, stringify } from 'yaml';
import type { CommandModule } from '../../contract/index.ts';

const config: CommandModule = {
  verb: 'config',
  async run(ctx, args) {
    const path = join(ctx.cwd, '.cohorte', 'config.yaml');
    let value: unknown;
    try {
      value = parse(await readFile(path, 'utf8'));
    } catch (error) {
      ctx.stdio.stderr.write(`cannot read ${path}: ${String(error)}\n`);
      return 1;
    }
    if (args.subVerb === 'validate') {
      const valid =
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        (value as { schemaVersion?: unknown }).schemaVersion === 1;
      ctx.stdio.stdout.write(`${valid ? 'valid' : 'invalid'}\n`);
      return valid ? 0 : 1;
    }
    if (args.subVerb === 'set') {
      const [key, rawValue] = args.positionals;
      if (!key || rawValue === undefined || !value || typeof value !== 'object' || Array.isArray(value)) return 2;
      const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      const parts = key.split('.').filter(Boolean);
      if (parts.length === 0) return 2;
      let cursor = next;
      for (const part of parts.slice(0, -1)) {
        const child = cursor[part];
        cursor[part] = child && typeof child === 'object' && !Array.isArray(child) ? { ...child } : {};
        cursor = cursor[part] as Record<string, unknown>;
      }
      cursor[parts.at(-1) as string] = parse(rawValue);
      await writeFile(path, stringify(next), 'utf8');
      if (args.json) ctx.stdio.stdout.write(`${JSON.stringify(next)}\n`);
      else ctx.stdio.stdout.write(`updated ${key}\n`);
      return 0;
    }
    if (args.subVerb === 'trust') {
      const home = ctx.env.HOME ?? ctx.cwd;
      const projectKeyId = sha256Hex(ctx.cwd).slice(0, 24);
      const keys = createKeyStore({ directory: join(home, '.cohorte', 'keys') });
      const trustStore = createTrustStore({ directory: join(home, '.cohorte', 'trust'), keys });
      const loaded = await loadConfig({ cwd: ctx.cwd, home });
      const resolved = await resolveConfig(loaded, {
        trustStore,
        projectKeyId,
      });
      const policySha256 = resolved.status === 'untrusted' ? resolved.policySha256 : resolved.trust.policySha256;
      const loosenedKeys = resolved.status === 'untrusted' ? resolved.loosenedKeys : resolved.trust.loosenedKeys;
      if (policySha256 === undefined) return 1;
      const flag = args.positionals.find((value) => value.startsWith('--'));
      if (flag === '--revoke') {
        const revoked = await trustStore.revoke(projectKeyId);
        ctx.stdio.stdout.write(`${JSON.stringify({ revoked })}\n`);
        return 0;
      }
      if (flag === '--grant') {
        const record = await trustStore.grant(projectKeyId, {
          policySha256,
          loosenedKeys,
          grantedBy: ctx.env.USER ?? 'cli',
        });
        ctx.stdio.stdout.write(`${JSON.stringify(record)}\n`);
        return 0;
      }
      const record = await trustStore.lookup(projectKeyId, policySha256);
      ctx.stdio.stdout.write(
        `${JSON.stringify({ policySha256, loosenedKeys, trusted: record !== undefined, record: record ?? null })}\n`,
      );
      return 0;
    }
    if (args.subVerb === 'get' || args.subVerb === undefined) {
      ctx.stdio.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return 0;
    }
    return 10;
  },
};

export default config;
