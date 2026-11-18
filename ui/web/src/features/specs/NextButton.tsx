import type { SpecRecord, Worktree } from '../../../../shared/api';
import { nextLabel, nextPrefill } from '../../lib/stage';
import { prefillRun } from '../../store/nav';
import { Button } from '../../ui/primitives';

/** The spec's next pipeline command. Clicking only prefills the Run form (worktree, command, argument): starting it stays a separate, confirmed step. */
export function NextButton({ spec, worktrees, why = false }: { spec: SpecRecord; worktrees: Worktree[]; why?: boolean }) {
  const prefill = nextPrefill(spec, worktrees);
  const n = spec.pipeline?.next;
  if (!n || !prefill) return null;
  return (
    <span className="next">
      <Button variant="primary" title={n.why} onClick={(e) => { e.stopPropagation(); prefillRun(prefill); }}>{nextLabel(spec)}</Button>
      {why ? <span className="muted"> — {n.why}</span> : null}
    </span>
  );
}
