import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '@cohorte/base';
import { DEFAULT_CONFIG } from '@cohorte/config/schema';
import { parse } from 'yaml';
import type { ReconcilePlan, RepositoryScanner } from '../contract.ts';
import { deriveDesiredState } from '../desired/index.ts';
import { diffStates, readActualState } from '../drift/index.ts';

export interface PlanReconcileOptions {
  root: string;
  /** injected: this area never imports the scan area */
  scan: RepositoryScanner;
  cohorteVersion: string;
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
    applyAvailable: false,
  };
}
