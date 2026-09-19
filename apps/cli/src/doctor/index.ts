// apps/cli/src/doctor/index.ts — AREA barrel: runs every `DOCTOR_CHECK_IDS` entry (contract/doctor.ts) through
// `doctor/checks/<id>/index.ts` and assembles a `DoctorReport`. Wave-0 stub: filled by `U4.05`, which owns
// `apps/cli/src/doctor/**` (this file included); only `checks/auth/**` is carved out to `U5.05`.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sha256Hex } from '@cohorte/base';
import { loadConfig, resolveConfig } from '@cohorte/config';
import { verifyProjectionAgainstEvents } from '@cohorte/core';
import { createKeyStore, createTrustStore } from '@cohorte/security/auth';
import { probeSandbox } from '@cohorte/security/exec';
import { type CliContext, DOCTOR_CHECK_IDS, type DoctorCheck, type DoctorCheckResult } from '../contract/index.ts';
import authDoctorCheck from './checks/auth/index.ts';

const exec = promisify(execFile);
const result = (id: string, summary: string, status: DoctorCheckResult['status'] = 'ok'): DoctorCheckResult => ({
  id,
  summary,
  status,
});

function versionAtLeast(value: string, required: [number, number]): boolean {
  const [major = 0, minor = 0] = value.split('.').map((part) => Number.parseInt(part, 10));
  return major > required[0] || (major === required[0] && minor >= required[1]);
}

export async function runDoctor(
  ctx: CliContext,
  options: { readonly verifyState?: boolean } = {},
): Promise<readonly DoctorCheckResult[]> {
  const checks: DoctorCheck[] = [
    {
      id: 'node-version',
      description: 'Node',
      run: async () =>
        versionAtLeast(process.versions.node, [24, 16])
          ? result('node-version', `Node ${process.versions.node}`)
          : result('node-version', `Node ${process.versions.node} is below 24.16`, 'error'),
    },
    {
      id: 'git',
      description: 'Git',
      run: async () => {
        try {
          const { stdout } = await exec('git', ['--version']);
          const version = stdout.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? '0.0.0';
          return versionAtLeast(version, [2, 38])
            ? result('git', `Git ${version}`)
            : result('git', `Git ${version} is below 2.38`, 'error');
        } catch (error) {
          return result('git', `git unavailable: ${String(error)}`, 'error');
        }
      },
    },
    {
      id: 'sqlite',
      description: 'SQLite',
      run: async () => {
        try {
          const store = await ctx.openStore();
          const info = await store.open();
          const migration = await store.migrate('check');
          await store.close();
          return migration.pending.length === 0
            ? result('sqlite', `${info.kind} schema ${info.schemaVersion}`)
            : result('sqlite', `${migration.pending.length} migration(s) pending`, 'warning');
        } catch (error) {
          return result('sqlite', `state store unavailable: ${String(error)}`, 'error');
        }
      },
    },
    {
      id: 'search-backend',
      description: 'Search',
      run: async () => {
        try {
          const { stdout } = await exec('rg', ['--version']);
          return result('search-backend', `ripgrep ${stdout.split(/\s+/u)[1] ?? 'available'}`);
        } catch {
          try {
            await exec('git', ['grep', '--version']);
            return result('search-backend', 'git grep fallback');
          } catch {
            return result('search-backend', 'neither rg nor git grep is available', 'error');
          }
        }
      },
    },
    {
      id: 'sandbox',
      description: 'Sandbox',
      run: async () => {
        const capabilities = await probeSandbox();
        return result(
          'sandbox',
          `level=${capabilities.level}, backend=${capabilities.backend}, filesystem=${capabilities.filesystem}, network=${capabilities.network}`,
          capabilities.level === 'L0-process' ? 'warning' : 'ok',
        );
      },
    },
    authDoctorCheck,
    {
      id: 'install',
      description: 'Install',
      run: async () => {
        try {
          const verified = await ctx.assets.verify();
          return verified.ok
            ? result('install', `${ctx.install.installDir()} (assets verified)`)
            : result('install', `asset verification failed: ${verified.error.message}`, 'error');
        } catch (error) {
          return result('install', `asset verification unavailable: ${String(error)}`, 'warning');
        }
      },
    },
    {
      id: 'config',
      description: 'Config',
      run: async () => {
        try {
          const home = ctx.env.HOME ?? ctx.cwd;
          const keys = createKeyStore({ directory: join(home, '.cohorte', 'keys') });
          const trustStore = createTrustStore({ directory: join(home, '.cohorte', 'trust'), keys });
          const loaded = await loadConfig({ cwd: ctx.cwd, home });
          const resolved = await resolveConfig(loaded, {
            trustStore,
            projectKeyId: sha256Hex(loaded.projectRoot).slice(0, 24),
          });
          return resolved.status === 'resolved'
            ? result('config', `project configuration resolved at ${loaded.projectRoot}`)
            : result('config', `project policy requires trust: ${resolved.loosenedKeys.join(', ')}`, 'warning');
        } catch (error) {
          return result('config', `configuration unavailable: ${String(error)}`, 'error');
        }
      },
    },
    {
      id: 'worktree-root',
      description: 'Worktree',
      run: async () =>
        typeof process.getuid === 'function' && process.getuid() === 0
          ? result('worktree-root', 'refusing to operate as uid 0', 'error')
          : result('worktree-root', ctx.cwd),
    },
  ];
  if (options.verifyState) {
    checks.push({
      id: 'verify-state',
      description: 'State verification',
      run: async () => {
        const store = await ctx.openStore();
        try {
          const runs = await store.listRuns({ limit: 100_000, offset: 0 });
          for (const run of runs) {
            const chain = await store.verifyChain(run.runId);
            if (!chain.ok) return result('verify-state', `run ${run.runId}: event chain is broken`, 'error');
            try {
              await verifyProjectionAgainstEvents(store, run);
            } catch (error) {
              return result('verify-state', `run ${run.runId}: projection mismatch (${String(error)})`, 'error');
            }
          }
          return result('verify-state', `verified ${runs.length} run(s)`);
        } finally {
          await store.close();
        }
      },
    });
  }
  const byId = new Map(checks.map((check) => [check.id, check]));
  return Promise.all(
    DOCTOR_CHECK_IDS.map(async (id) => byId.get(id)?.run(ctx) ?? result(id, 'check unavailable', 'skipped')),
  );
}
