import type { PipelineStage } from '../../../../shared/api';

const MARK: Record<string, string> = { done: '✓', current: '●', blocked: '!', skipped: '–', todo: '' };

/** Spec → Build → Review → Verify → Ship, each coloured by its state. Colour is never the only signal: every step also carries a mark and a title. */
export function Stepper({ stages }: { stages: PipelineStage[] }) {
  return (
    <ol className="stepper" aria-label="Pipeline stages">
      {stages.map((s) => (
        <li key={s.key} className={`step step-${s.state}`} title={`${s.label}: ${s.state}`}>
          <span className="step-mark" aria-hidden="true">{MARK[s.state]}</span>
          <span className="step-label">{s.label}<span className="sr-only">{` — ${s.state}`}</span></span>
        </li>
      ))}
    </ol>
  );
}
