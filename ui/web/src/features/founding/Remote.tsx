import { useEffect, useState, type FormEvent } from 'react';
import { usePoll } from '../../lib/usePoll';
import { connectRemote, loadRemote, useFounding } from '../../store/founding';
import { LIVE, useJobs } from '../../store/jobs';
import { useApp } from '../../store/app';
import { Button, Card, Muted, Pill } from '../../ui/primitives';
import { JobPanel } from '../worktrees/JobPanel';

/**
 * Where the code is hosted. Never required — a project can stay on this machine — and one step when wanted:
 * a new GitHub repository through `gh`, or the URL of an empty repository made anywhere else (GitLab, Gitea…).
 */
export function RemoteCard({ compact = false }: { compact?: boolean }) {
  const sel = useApp((s) => s.sel);
  const sum = useApp((s) => s.projects.find((p) => p.id === s.sel));
  const remote = useFounding((s) => s.remote);
  const busy = useFounding((s) => s.remoteBusy);
  const job = useJobs((s) => s.job);
  const [kind, setKind] = useState<'github' | 'url'>('github');
  const [name, setName] = useState('');
  const [vis, setVis] = useState('private');
  const [url, setUrl] = useState('');
  useEffect(() => { void loadRemote(); }, [sel]);
  useEffect(() => { if (sum && !name) setName(sum.name); }, [sum?.name]);
  const mine = !!job && /^(GitHub|push) · /.test(job.label);
  usePoll(async () => { const again = await useJobs.getState().poll(); if (!again) await loadRemote(true); return again; }, 1200, mine && LIVE.includes(job?.status ?? ''), `${job?.id}:${job?.status}`);
  if (!remote) return compact ? null : <Card><Muted>{busy ? 'Looking at the code host…' : 'Unknown.'}</Muted></Card>;
  if (remote.origin) {
    if (compact) return null;
    return <Card><Pill tone="ok">Hosted</Pill><div className="mono gap-top">{remote.origin}</div>{remote.ahead ? <Muted>{`${remote.ahead} commit${remote.ahead === 1 ? '' : 's'} not pushed yet on ${remote.branch}`}</Muted> : null}{mine ? <JobPanel /> : null}</Card>;
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (kind === 'github') { if (name.trim()) void connectRemote({ kind, name: name.trim(), visibility: vis }); }
    else if (url.trim()) void connectRemote({ kind, url: url.trim() });
  };
  return (
    <Card>
      <div className="plan-head"><Pill tone="idle">On this machine only</Pill><span className="muted">No code host yet — the code is safe here, but pull requests need one.</span></div>
      <form onSubmit={submit} className="gap-top">
        <div className="seg" role="radiogroup" aria-label="Code host">
          <label><input type="radio" name="host" checked={kind === 'github'} onChange={() => setKind('github')} /> A new GitHub repository</label>
          <label><input type="radio" name="host" checked={kind === 'url'} onChange={() => setKind('url')} /> A repository I already created (GitLab, GitHub, other)</label>
        </div>
        {kind === 'github' ? (
          !remote.gh.installed ? <Muted>The GitHub CLI is not installed: install it from cli.github.com, or use a repository you created yourself.</Muted>
            : !remote.gh.authed ? <Muted>The GitHub CLI is not signed in: run <span className="mono">gh auth login</span> in a terminal once, then reload this page.</Muted>
              : (
                <div className="row-form wrap">
                  <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Repository name" placeholder="name, or owner/name for an organisation" />
                  <select value={vis} onChange={(e) => setVis(e.target.value)} aria-label="Visibility"><option value="private">Private</option><option value="internal">Internal</option><option value="public">Public</option></select>
                  <Button type="submit" variant="primary" disabled={!name.trim() || mine && LIVE.includes(job?.status ?? '')}>{`Create on GitHub as ${remote.gh.user ?? 'you'} and push`}</Button>
                </div>
              )
        ) : (
          <div className="row-form wrap">
            <input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Repository URL" placeholder="git@gitlab.com:team/project.git or https://…" />
            <Button type="submit" variant="primary" disabled={!url.trim()}>Connect and push</Button>
          </div>
        )}
        <Muted>The pipeline profile is pointed at the new host (so shipping opens pull requests there), committed, then everything is pushed.</Muted>
      </form>
      {mine ? <JobPanel /> : null}
    </Card>
  );
}
