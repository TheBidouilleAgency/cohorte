import { appendFile, copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Clock } from '@cohorte/base';
import { DEFAULT_CONFIG } from '@cohorte/config/schema';
import { parse } from 'yaml';
import type { DesiredState, ReconcilePlan, RepositoryScanner } from '../contract.ts';
import { deriveDesiredState } from '../desired/index.ts';
import { diffStates, readActualState } from '../drift/index.ts';

export interface PlanReconcileOptions {
  root: string;
  /** injected: this area never imports the scan area */
  scan: RepositoryScanner;
  cohorteVersion: string;
  clock: Clock;
}

export interface ApplyReconcileOptions {
  root: string;
  plan: ReconcilePlan;
  desired: DesiredState;
  backup?: boolean;
  clock: Clock;
}

/** READ-ONLY. */
export async function planReconcile(options: PlanReconcileOptions): Promise<ReconcilePlan> {
  const model = await options.scan(options.root);
  // `provenance.generatedAt` is metadata, not project content. Reuse the
  // previous generated timestamp so a read-only reconcile is stable; changed
  // model fields still alter the rendered project and manifest hashes.
  let stableModel = model;
  try {
    const actual = parse(await readFile(join(options.root, '.cohorte', 'project.yaml'), 'utf8')) as {
      provenance?: { generatedAt?: unknown };
    };
    const generatedAt = actual.provenance?.generatedAt;
    const stableGeneratedAt =
      generatedAt instanceof Date
        ? generatedAt.toISOString()
        : typeof generatedAt === 'string'
          ? generatedAt
          : undefined;
    if (stableGeneratedAt !== undefined) {
      stableModel = {
        ...model,
        provenance: {
          ...model.provenance,
          generatedAt: stableGeneratedAt as typeof model.provenance.generatedAt,
        },
      };
    }
  } catch {
    /* an uninitialised or malformed project is represented by the normal drift entries */
  }
  const desired = deriveDesiredState({
    model: stableModel,
    config: DEFAULT_CONFIG,
    cohorteVersion: options.cohorteVersion,
    skills: {},
  });
  const actual = await readActualState(options.root);
  const drift = diffStates(desired, actual, options.clock);
  const operations = drift.entries.map((entry) => {
    const op =
      entry.diff === 'absent'
        ? 'create'
        : entry.diff === 'expected-change'
          ? 'replace'
          : entry.diff === 'potential-deletion'
            ? 'delete'
            : entry.diff === 'unknown'
              ? 'keep'
              : 'ask';
    return { op, target: entry.target, diff: entry.diff, reason: entry.detail } as const;
  });
  return {
    schemaVersion: 1,
    cohorteVersion: options.cohorteVersion,
    generatedAt: drift.generatedAt,
    drift,
    operations,
    conflicts: drift.entries.filter((entry) => entry.diff === 'conflict').map((entry) => entry.target),
    applyAvailable: true,
  };
}

/** Apply only create/replace/delete operations authorized by a conflict-free plan. */
export async function applyReconcile(options: ApplyReconcileOptions): Promise<{
  applied: string[];
  skipped: string[];
  backupDir?: string;
  journal: string;
}> {
  if (options.plan.conflicts.length > 0)
    throw new Error(`conflict/reconcile-human-edit: ${options.plan.conflicts.join(', ')}`);
  const desiredByPath = new Map(options.desired.files.map((file) => [file.path, file]));
  const backupDir = options.backup
    ? join(options.root, '.cohorte', 'reconcile-backups', options.clock.now().replaceAll(':', ''))
    : undefined;
  const journal = join(options.root, '.cohorte', 'reconcile.log');
  await mkdir(join(options.root, '.cohorte'), { recursive: true, mode: 0o700 });
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const operation of options.plan.operations) {
    if (operation.op !== 'create' && operation.op !== 'replace' && operation.op !== 'delete') {
      skipped.push(operation.target);
      continue;
    }
    const target = join(options.root, '.cohorte', operation.target);
    if (!target.startsWith(`${join(options.root, '.cohorte')}/`)) throw new Error('security/path-outside-grant');
    const existing = await readFile(target).catch(() => undefined);
    if (existing !== undefined && backupDir) {
      const backupPath = join(backupDir, operation.target);
      await mkdir(dirname(backupPath), { recursive: true });
      await copyFile(target, backupPath);
    }
    if (operation.op === 'delete') await unlink(target).catch(() => undefined);
    else {
      const file = desiredByPath.get(operation.target);
      if (file?.content === undefined) throw new Error(`configuration/reconcile-content-missing: ${operation.target}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
    }
    applied.push(operation.target);
    await appendFile(
      journal,
      `${JSON.stringify({ at: options.clock.now(), op: operation.op, target: operation.target })}\n`,
    );
  }
  return { applied, skipped, ...(backupDir ? { backupDir } : {}), journal };
}
