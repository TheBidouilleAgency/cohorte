import type { GitInfo, PullInfo } from '../../../../shared/api';
import { Pill, type PillTone } from '../../ui/primitives';

const SAFE_URL = /^https?:\/\//i;

/** ↑2 ↓1 and the dirty counts of one worktree. */
export function BranchState({ g }: { g: GitInfo | undefined }) {
  if (!g) return null;
  if (g.error) return <div className="muted">{g.error}</div>;
  return (
    <div className="git-state">
      {g.ahead ? <span className="mono" title={`${g.ahead} commit(s) ahead of ${g.upstream ?? 'upstream'}`}>{`↑${g.ahead}`}</span> : null}
      {g.behind ? <span className="mono" title={`${g.behind} commit(s) behind ${g.upstream ?? 'upstream'}`}>{`↓${g.behind}`}</span> : null}
      {g.conflicted ? <Pill tone="bad">{`${g.conflicted} conflicted`}</Pill> : null}
      {g.clean ? <span className="muted">clean</span> : (
        <span className="muted mono">{[g.staged && `${g.staged} staged`, g.modified && `${g.modified} modified`, g.untracked && `${g.untracked} untracked`].filter(Boolean).join(' · ')}</span>
      )}
    </div>
  );
}

export function LastCommit({ g }: { g: GitInfo | undefined }) {
  if (!g?.lastCommit) return null;
  return <div className="muted last-commit"><span className="mono">{g.lastCommit.sha}</span>{` ${g.lastCommit.subject} · ${g.lastCommit.when}`}</div>;
}

/** +N −N over M files against the default branch. */
export function DiffStat({ g }: { g: GitInfo | undefined }) {
  if (!g || g.error || !g.base) return <span className="muted">–</span>;
  const d = g.diff;
  if (!d.files) return <span className="muted">no changes vs {g.base}</span>;
  return <span className="mono" title={`against ${g.base}`}><span className="add">{`+${d.insertions}`}</span>{' '}<span className="del">{`−${d.deletions}`}</span><span className="muted">{` · ${d.files} file${d.files === 1 ? '' : 's'}`}</span></span>;
}

const stateTone = (p: PullInfo): PillTone => (p.state === 'MERGED' ? 'info' : p.state === 'CLOSED' ? 'bad' : p.draft ? '' : 'ok');

/** The branch's pull request: number, state, checks, review decision — a link to GitHub. */
export function PullChip({ p }: { p: PullInfo | null | undefined }) {
  if (!p) return null;
  const label = `#${p.number} ${p.draft ? 'draft' : p.state.toLowerCase()}`;
  const checks = p.checks ? ` · checks ${p.checks === 'success' ? '✓' : p.checks === 'failure' ? '✗' : '…'}` : '';
  const review = p.review ? ` · ${p.review.toLowerCase().replace(/_/g, ' ')}` : '';
  const tone = p.checks === 'failure' ? 'bad' : stateTone(p);
  const text = `${label}${checks}${review}`;
  const cls = `pill pill-${tone || 'idle'} pr-chip`;
  return SAFE_URL.test(p.url)
    ? <a className={cls} href={p.url} target="_blank" rel="noopener noreferrer" title={p.title}>{text}</a>
    : <span className={cls} title={p.title}>{text}</span>;
}

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/;
/** Open links for the local URLs a dev server printed. */
export function OpenLinks({ urls }: { urls: string[] | undefined }) {
  const safe = (urls ?? []).filter((u) => LOCAL_URL.test(u));
  if (!safe.length) return null;
  return <>{safe.map((u) => <a key={u} className="open-link mono" href={u} target="_blank" rel="noopener noreferrer">{`Open ${u.replace(/^https?:\/\//, '')} ↗`}</a>)}</>;
}
