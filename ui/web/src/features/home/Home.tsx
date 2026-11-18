import type { ActivityItem, ProjectSummary } from '../../../../shared/api';
import { byProject, useActivity } from '../../store/activity';
import { selectProject, useApp, type TabId } from '../../store/app';
import { Dot, EmptyState, Muted, Pill, SectionTitle } from '../../ui/primitives';

const tone = (p: ProjectSummary): 'ok' | 'warn' | 'bad' => (p.error || p.missing || !p.summary ? 'bad' : p.summary.bad ? 'bad' : p.summary.warn ? 'warn' : 'ok');
const KIND_TAB: Record<ActivityItem['kind'], TabId> = { dev: 'worktrees', job: 'worktrees', docker: 'docker', run: 'run' };

function ProjectCard({ p, running, pending }: { p: ProjectSummary; running: number; pending: number }) {
  const counts = Object.entries(p.specCounts ?? {});
  return (
    <button type="button" className="card home-card link" onClick={() => void selectProject(p.id)}>
      <span className="proj-name"><Dot tone={tone(p)} />{p.title || p.name}</span>
      <span className="muted home-line">{p.missing ? 'folder missing' : p.error ? p.error : p.oneLiner || p.root}</span>
      {p.summary ? <span className="muted home-line">{`${p.summary.ok} ok · ${p.summary.warn} to review · ${p.summary.bad} failing`}</span> : null}
      <span className="home-chips">
        {counts.map(([k, v]) => <Pill key={k}>{`${v} ${k}`}</Pill>)}
        {running ? <Pill tone="info">{`${running} running`}</Pill> : null}
        {pending ? <Pill tone="warn">{`${pending} needs you`}</Pill> : null}
      </span>
    </button>
  );
}

export function Home() {
  const projects = useApp((s) => s.projects);
  const items = useActivity((s) => s.items);
  const per = byProject(items);
  const sorted = [...items].sort((a, b) => b.pending - a.pending || b.startedAt.localeCompare(a.startedAt));
  if (!projects.length) return <EmptyState><h2>No project yet</h2>Add a repo that has a PIPELINE.md using the field on the left.</EmptyState>;
  return (
    <div>
      <h2>Home</h2>
      <Muted>{`${projects.length} project${projects.length === 1 ? '' : 's'} on this machine`}</Muted>
      <SectionTitle>Projects</SectionTitle>
      <div className="cards home-cards">{projects.map((p) => <ProjectCard key={p.id} p={p} running={per[p.id]?.running ?? 0} pending={per[p.id]?.pending ?? 0} />)}</div>
      <SectionTitle>Activity</SectionTitle>
      {sorted.length ? (
        <ul className="activity">
          {sorted.map((i) => (
            <li key={`${i.kind}:${i.id}`}>
              <button type="button" className="act-row" onClick={() => void selectProject(i.projectId, KIND_TAB[i.kind])}>
                <span className="mono act-proj">{i.projectName}</span>
                <Pill tone={i.kind === 'run' ? 'info' : ''}>{i.kind}</Pill>
                <span className="act-label">{i.label}</span>
                <span className="muted">{i.status}</span>
                {i.pending ? <Pill tone="warn">needs you</Pill> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : <Muted>Nothing is running. Dev servers, Cohorte commands and Docker jobs show up here.</Muted>}
    </div>
  );
}
