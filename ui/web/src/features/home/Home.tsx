import { useEffect } from 'react';
import type { ActivityItem, InboxItem, ProjectSummary } from '../../../../shared/api';
import { loadInbox, openChat, openFeature, selectTicket, useFlow } from '../../store/flow';
import { openRun } from '../../store/run';
import { byProject, useActivity } from '../../store/activity';
import { selectProject, useApp, type TabId } from '../../store/app';
import { Button, Dot, EmptyState, Muted, Pill, SectionTitle } from '../../ui/primitives';
import { openNewProject, useFounding } from '../../store/founding';
import { NewProject } from '../founding/NewProject';

const tone = (p: ProjectSummary): 'ok' | 'warn' | 'bad' => (p.error || p.missing || !p.summary ? 'bad' : p.summary.bad ? 'bad' : p.summary.warn ? 'warn' : 'ok');
const KIND_TAB: Record<ActivityItem['kind'], TabId> = { dev: 'worktrees', job: 'worktrees', docker: 'docker', run: 'run' };

function ProjectCard({ p, running, pending }: { p: ProjectSummary; running: number; pending: number }) {
  const counts = Object.entries(p.specCounts ?? {});
  return (
    <button type="button" className="card home-card link" onClick={() => void selectProject(p.id)}>
      <span className="proj-name"><Dot tone={tone(p)} />{p.title || p.name}</span>
      <span className="muted home-line">{p.founding ? 'being founded — open it to continue' : p.missing ? 'folder missing' : p.error ? p.error : p.oneLiner || p.root}</span>
      {p.summary ? <span className="muted home-line">{`${p.summary.ok} ok · ${p.summary.warn} to review · ${p.summary.bad} failing`}</span> : null}
      <span className="home-chips">
        {counts.map(([k, v]) => <Pill key={k}>{`${v} ${k}`}</Pill>)}
        {running ? <Pill tone="info">{`${running} running`}</Pill> : null}
        {pending ? <Pill tone="warn">{`${pending} needs you`}</Pill> : null}
      </span>
    </button>
  );
}

const INBOX: Record<InboxItem['kind'], [string, TabId]> = {
  cp0: ['CP0 · ticket to validate', 'tickets'], cp1: ['CP1 · plan to approve', 'features'], cp2: ['CP2 · course check', 'features'],
  cp3: ['CP3 · ready to ship', 'features'], cp4: ['CP4 · delivery to accept', 'tickets'], pr: ['PR to merge', 'features'],
  question: ['question', 'features'], permission: ['permission', 'features'], founding: ['new project', 'overview'],
};

/** Everything across projects that waits on a person: checkpoints, questions the decider handed over, gate asks. */
export function Inbox() {
  const items = useFlow((s) => s.inbox);
  useEffect(() => { void loadInbox(); }, []);
  const go = async (i: InboxItem) => {
    const [, tab] = INBOX[i.kind];
    if (i.kind === 'founding' || useApp.getState().projects.find((p) => p.id === i.projectId)?.founding) { await selectProject(i.projectId); return; }
    await selectProject(i.projectId, i.kind === 'question' || i.kind === 'permission' ? (i.feature ? 'features' : 'overview') : tab);
    if (tab === 'tickets') selectTicket(i.ref);
    else if (i.feature) await openFeature(i.feature);
    else if (i.kind === 'question' || i.kind === 'permission') {
      // a run outside any feature: a PO conversation (Tickets) or a command started by hand (Run)
      await openChat(i.ref);
      if (useFlow.getState().chat?.meta?.role === 'po') useApp.getState().setTab('tickets');
      else { useApp.getState().setTab('run'); await openRun(i.ref); }
    }
  };
  return (
    <>
      <SectionTitle>Waiting for you</SectionTitle>
      {items.length ? (
        <ul className="activity">
          {items.map((i) => (
            <li key={`${i.kind}:${i.projectId}:${i.ref}:${i.detail}`}>
              <button type="button" className="act-row" onClick={() => void go(i)}>
                <span className="mono act-proj">{i.projectName}</span>
                <Pill tone="warn">{INBOX[i.kind][0]}</Pill>
                <span className="act-label">{i.title}<span className="muted">{` — ${i.detail}`}</span></span>
              </button>
            </li>
          ))}
        </ul>
      ) : <Muted>Nothing waits on you.</Muted>}
    </>
  );
}

export function Home() {
  const projects = useApp((s) => s.projects);
  const items = useActivity((s) => s.items);
  const per = byProject(items);
  const sorted = [...items].sort((a, b) => b.pending - a.pending || b.startedAt.localeCompare(a.startedAt));
  const form = useFounding((s) => s.form);
  if (!projects.length) return (
    <div>
      {form ? <NewProject /> : (
        <EmptyState><h2>No project yet</h2><p>Start a new one from an idea or a stack, set up a repository you already have, or add a cohorte project with the field on the left.</p>
          <Button variant="primary" onClick={() => openNewProject('idea')}>New project</Button></EmptyState>
      )}
    </div>
  );
  return (
    <div>
      <div className="toolbar between"><h2>Home</h2>{form ? null : <Button variant="primary" onClick={() => openNewProject('idea')}>New project</Button>}</div>
      <NewProject />
      <Muted>{`${projects.length} project${projects.length === 1 ? '' : 's'} on this machine`}</Muted>
      <Inbox />
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
