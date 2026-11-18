import type { ProjectDetail, SpecDetail as Detail } from '../../../../shared/api';
import { closeSpec } from '../../store/specs';
import { Button, Muted, Pre, SectionTitle } from '../../ui/primitives';
import { Findings } from './Findings';
import { NextButton } from './NextButton';
import { ReportCards } from './ReportCards';
import { Stepper } from './Stepper';
import { Verdict } from './Verdict';

export function SpecDetail({ spec, d }: { spec: Detail; d: ProjectDetail }) {
  const s = spec.spec;
  return (
    <div>
      <Button onClick={closeSpec}>← Specs</Button>
      <h2 className="spec-title">{s.title || s.id}</h2>
      <Muted mono>{`${s.id} · ${s.status || 'unknown'}${s.kind ? ` · ${s.kind}` : ''}${s.branch ? ` · ${s.branch}` : ''}`}</Muted>
      <div className="spec-head">
        <Stepper stages={spec.pipeline.stages} />
        <Verdict v={spec.pipeline.verdict} />
      </div>
      <NextButton spec={{ ...s, pipeline: spec.pipeline }} worktrees={d.worktrees} why />
      <Findings review={spec.review} />
      <ReportCards reports={spec.reports} />
      <SectionTitle>Spec</SectionTitle>
      <Pre>{spec.body}</Pre>
    </div>
  );
}
