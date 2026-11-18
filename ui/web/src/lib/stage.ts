import type { PipelineInfo, SpecRecord, Worktree } from '../../../shared/api';

/** The board column a spec sits in: the first stage that is not finished (or skipped); `done` once every stage is. */
export type Column = 'spec' | 'build' | 'review' | 'verify' | 'ship' | 'done';
export const COLUMNS: { key: Column; label: string }[] = [
  { key: 'spec', label: 'Spec' }, { key: 'build', label: 'Build' }, { key: 'review', label: 'Review' },
  { key: 'verify', label: 'Verify' }, { key: 'ship', label: 'Ship' }, { key: 'done', label: 'Closed' },
];

export function columnOf(spec: Pick<SpecRecord, 'status'> & { pipeline?: PipelineInfo }): Column {
  if (spec.status === 'abandoned') return 'done';
  const stages = spec.pipeline?.stages ?? [];
  const open = stages.find((s) => s.state !== 'done' && s.state !== 'skipped');
  return (open?.key as Column | undefined) ?? 'done';
}

export interface RunPrefill { wt: string; cmd: string; args: string }

/** Prefill for the Run form from a spec's next step: its worktree (by branch) else the main checkout. Never starts anything. */
export function nextPrefill(spec: Pick<SpecRecord, 'branch'> & { pipeline?: PipelineInfo }, worktrees: Worktree[]): RunPrefill | null {
  const next = spec.pipeline?.next;
  if (!next) return null;
  const usable = worktrees.filter((w) => !w.bare);
  const wt = usable.find((w) => w.branch && spec.branch && w.branch === spec.branch) ?? usable.find((w) => w.main) ?? usable[0];
  return wt ? { wt: wt.path, cmd: next.command, args: next.args } : null;
}

export const nextLabel = (spec: { pipeline?: PipelineInfo }): string => {
  const n = spec.pipeline?.next;
  return n ? `Run /${n.command} ${n.args}` : '';
};
