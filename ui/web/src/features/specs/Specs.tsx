import { LayoutGrid, List } from 'lucide-react';
import type { ProjectDetail, SpecRecord } from '../../../../shared/api';
import { COLUMNS, columnOf } from '../../lib/stage';
import { openSpec, useSpecs } from '../../store/specs';
import { useUi, type SpecView } from '../../store/ui';
import { EmptyState, Pill, Table, type PillTone } from '../../ui/primitives';
import { NextButton } from './NextButton';
import { SpecDetail } from './SpecDetail';
import { Stepper } from './Stepper';
import { Verdict } from './Verdict';

export const STATUS_TONE: Record<string, PillTone> = { shipped: 'ok', merged: 'ok', blocked: 'bad', abandoned: 'warn' };
const statusTone = (s: SpecRecord): PillTone => STATUS_TONE[s.status] ?? (s.tone === 'warn' ? 'warn' : '');
const open = (id: string) => ({ tabIndex: 0, onClick: () => void openSpec(id), onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') void openSpec(id); } });

function ViewToggle() {
  const { specView, setSpecView } = useUi();
  const opt = (v: SpecView, label: string, icon: React.ReactNode) => (
    <button type="button" className={`seg${specView === v ? ' sel' : ''}`} aria-pressed={specView === v} onClick={() => setSpecView(v)}>{icon}{label}</button>
  );
  return <div className="seg-group" role="group" aria-label="Spec layout">{opt('list', 'List', <List size={13} />)}{opt('board', 'Board', <LayoutGrid size={13} />)}</div>;
}

function ListView({ d }: { d: ProjectDetail }) {
  return (
    <Table head={['Spec', 'Pipeline', 'Status', 'Next']}>
      {d.specs.map((s) => (
        <tr key={s.id} className="click" {...open(s.id)}>
          <td><div className="mono">{s.id}</div><div>{s.title}</div>{s.branch ? <div className="muted mono">{s.branch}</div> : null}</td>
          <td>{s.pipeline ? <Stepper stages={s.pipeline.stages} /> : null}</td>
          <td><Pill tone={statusTone(s)}>{s.status}</Pill>{s.pipeline?.verdict ? <div className="gap-top"><Verdict v={s.pipeline.verdict} /></div> : null}</td>
          <td><NextButton spec={s} worktrees={d.worktrees} /></td>
        </tr>
      ))}
    </Table>
  );
}

function BoardView({ d }: { d: ProjectDetail }) {
  return (
    <div className="board" role="list">
      {COLUMNS.map((c) => {
        const here = d.specs.filter((s) => columnOf(s) === c.key);
        return (
          <section key={c.key} className="col" role="listitem" aria-label={`${c.label}, ${here.length} specs`}>
            <h4 className="col-head">{c.label}<span className="count">{here.length}</span></h4>
            {here.map((s) => (
              <article key={s.id} className="spec-card click" {...open(s.id)}>
                <div className="mono">{s.id}</div>
                <div>{s.title}</div>
                <div className="spec-card-meta"><Pill tone={statusTone(s)}>{s.status}</Pill><Verdict v={s.pipeline?.verdict ?? null} /></div>
                <NextButton spec={s} worktrees={d.worktrees} />
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}

export function Specs({ d }: { d: ProjectDetail }) {
  const spec = useSpecs((s) => s.spec);
  const view = useUi((s) => s.specView);
  if (spec) return <SpecDetail spec={spec} d={d} />;
  if (!d.specs.length) return <EmptyState>No specs yet. Run /cohorte-brainstorm in Claude Code.</EmptyState>;
  return (
    <div>
      <div className="toolbar between"><span className="muted">{`${d.specs.length} spec${d.specs.length === 1 ? '' : 's'}`}</span><ViewToggle /></div>
      {view === 'board' ? <BoardView d={d} /> : <ListView d={d} />}
    </div>
  );
}
