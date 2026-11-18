import { useEffect, useState, type FormEvent } from 'react';
import type { ProjectDetail } from '../../../../shared/api';
import { api } from '../../api/client';
import { usePoll } from '../../lib/usePoll';
import { loadGit, openDiff, useGit } from '../../store/git';
import { LIVE, stopJob, useJobs } from '../../store/jobs';
import { createWorktree, removeWorktree, startDev, usePreflight } from '../../store/worktrees';
import { useApp } from '../../store/app';
import { Button, Card, Muted, Pill, SectionTitle, Table } from '../../ui/primitives';
import { DiffPanel } from './DiffPanel';
import { BranchState, DiffStat, LastCommit, OpenLinks, PullChip } from './GitCells';
import { JobPanel } from './JobPanel';

function PreflightCard() {
  const pre = usePreflight((s) => s.preflight);
  const setTab = useApp((s) => s.setTab);
  const watch = useJobs((s) => s.watch);
  if (!pre) return null;
  const startStack = () => void useApp.getState().act(async () => {
    const sel = useApp.getState().sel;
    usePreflight.setState({ preflight: null });
    if (sel) watch((await api.dockerAct(sel, { action: 'up' })).job);
  });
  return (
    <Card tone="warn" className="gate">
      <Pill tone="warn">Docker is not ready</Pill>
      <p>{pre.message}</p>
      {pre.daemonUp ? <Button onClick={startStack}>Start the stack</Button> : <Button onClick={() => setTab('docker')}>Open the Docker tab</Button>}{' '}
      <Button onClick={() => void createWorktree(pre.feature, true)}>Create anyway</Button>{' '}
      <Button onClick={() => usePreflight.setState({ preflight: null })}>Cancel</Button>
      {pre.daemonUp ? null : <div className="fix">Start Docker Desktop (or the docker service), then try again.</div>}
    </Card>
  );
}

export function Worktrees({ d }: { d: ProjectDetail }) {
  const [feature, setFeature] = useState('');
  const watch = useJobs((s) => s.watch);
  const git = useGit((s) => s.git);
  useEffect(() => { void loadGit(); }, [d.id, d.worktrees.length]);
  usePoll(async () => { await loadGit(); }, 20000, true, d.id);
  const submit = (e: FormEvent) => { e.preventDefault(); const f = feature.trim(); if (f) void createWorktree(f); };
  const live = (st?: string) => !!st && LIVE.includes(st);
  return (
    <div>
      <Muted>{d.dev.command ? <>Dev command: <span className="mono">{d.dev.command}</span></> : 'No commands.dev in this project’s profile — dev servers cannot be started from here.'}</Muted>
      <Table head={['Worktree', 'Branch', 'Changes', 'Dev server', '']}>
        {d.worktrees.map((w) => {
          const g = git?.worktrees[w.path];
          return (
            <tr key={w.path}>
              <td><span className="mono">{w.path}</span>{w.main ? <> <Pill>main</Pill></> : null}<LastCommit g={g} /></td>
              <td><span className="mono">{w.branch || (w.bare ? 'bare' : 'detached')}</span><BranchState g={g} /></td>
              <td><DiffStat g={g} />{g?.pull ? <div className="gap-top"><PullChip p={g.pull} /></div> : null}</td>
              <td>
                {w.dev ? <Pill tone={w.dev.status === 'ready' ? 'ok' : w.dev.status === 'failed' ? 'bad' : ''}>{w.dev.status}</Pill> : <span className="muted">stopped</span>}
                <div className="open-links"><OpenLinks urls={w.dev?.urls} /></div>
              </td>
              <td><div className="actions">
                {live(w.dev?.status) && w.dev ? <Button onClick={() => void stopJob(w.dev!.id)}>Stop</Button>
                  : d.dev.command && !w.bare ? <Button onClick={() => void startDev(w)}>Start dev</Button> : null}
                {w.dev ? <Button onClick={() => watch(w.dev!)}>Logs</Button> : null}
                {!w.bare ? <Button onClick={() => void openDiff(w.path)}>Diff</Button> : null}
                {!w.main ? <Button onClick={() => void removeWorktree(w)}>Remove</Button> : null}
              </div></td>
            </tr>
          );
        })}
      </Table>
      {git && !git.gh ? <Muted>Install and sign in to the GitHub CLI (gh) to see each branch’s pull request and checks here.</Muted> : null}
      <DiffPanel />
      <SectionTitle>New worktree</SectionTitle>
      <form className="row-form" onSubmit={submit}>
        <input value={feature} onChange={(e) => setFeature(e.target.value)} placeholder="feature-id (kebab-case)" aria-label="Feature id" />
        <Button type="submit">Create</Button>
      </form>
      <Muted>{d.isolation.create ? 'Uses scripts/new-feature.sh (own DB and ports).' : 'Plain git worktree next to the repo, on a new branch.'}</Muted>
      <PreflightCard />
      <JobPanel />
    </div>
  );
}
